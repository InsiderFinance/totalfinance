/**
 * eSSVI — the extended SSVI surface (spec: `docs/specs/essvi-surface.md`, roadmap Tier 2). Where `ssvi.ts`
 * ties the WHOLE surface to one global skew `ρ`, eSSVI lets `ρ` vary with maturity, `ρ(θ)`, so a steep
 * short-dated skew and a mild long-dated one can be fit at once — while the curvature `φ(θ)` stays a global
 * function. At a fixed θ an eSSVI slice IS an SSVI slice (hence a raw-SVI slice), so evaluation and the
 * Gatheral-`g` butterfly test reuse `./ssvi.ts`/`./svi.ts`.
 *
 *   w(k, θ) = (θ/2)·[ 1 + ρ(θ)·ψ·k + √((ψ·k + ρ(θ))² + (1 − ρ(θ)²)) ],   ψ = φ(θ)
 *
 * When `ρ(θ)` is constant, eSSVI reduces exactly to SSVI. Because `ρ` now varies, a non-decreasing `θ(t)`
 * is NO LONGER sufficient for calendar-arbitrage-freedom (a steep short slice can push its deep-wing total
 * variance above a longer slice), so the calendar check scans the `(k, t)` grid directly — the definition:
 * `w(k, t)` non-decreasing in `t` at every `k`.
 */

import {
  type ClosedRequestSpecification,
  CONVENTIONS_VERSION,
  type Diagnostics,
  ErrorCode,
  InputError,
  type QuantWarning,
  ensureFinite,
  requireArgumentObject,
  validateClosedRequest,
  warning,
  WarningCode,
} from '@totalfinance/core';
import { nelderMead } from '@totalfinance/math';
import { sviMinG } from './svi.js';
import {
  type SSVIPhi,
  type SSVISliceInput,
  calibrateSsvi,
  calibrationWeights,
  prepareSlices,
  thetaAt,
} from './ssvi.js';
import { phiValueUnchecked, ssviSliceWUnchecked, ssviToSviUnchecked } from './ssvi-kernel.js';
import { VALIDATION_SPECS } from './generated/validation-specs.js';
import { requireCalibrationIterationBudget } from './calibration-limits.js';
import { requireSsviStart } from './calibration-start.js';

/** Calibrated eSSVI surface parameters — SSVI with a per-maturity skew. */
export interface ESSVIParameters {
  /** Curvature function (global), same family as SSVI. */
  phi: SSVIPhi;
  /** Per-knot `(t, θ, ρ)`: θ strictly increasing (calendar backbone), ρ ∈ (−1, 1) per maturity. */
  thetaTerm: Array<{ timeToExpiryYears: number; theta: number; rho: number }>;
}

/** No-arbitrage diagnosis of an eSSVI surface. */
export interface ESSVIArbitrage {
  /** No calendar-spread arbitrage — `w(k, t)` non-decreasing in `t` at every grid `k` (the definition). */
  calendarArbitrageFree: boolean;
  /** No butterfly arbitrage — the exact Gatheral `g ≥ 0` density test at every grid maturity. */
  butterflyArbitrageFree: boolean;
  /** The minimum Gatheral `g(k)` over the grid and maturities (`≥ 0` ⇔ butterfly-free). */
  minButterflyG: number;
  /** Minimum `Δw` between adjacent maturities over the grid (`≥ 0` ⇔ calendar-free). */
  minCalendarSlope: number;
}

/** One maturity slice of the market surface (same shape as SSVI's). */
export type ESSVISliceInput = SSVISliceInput;

/** Input for {@link calibrateEssvi}. */
export interface ESSVICalibrationInput {
  slices: ESSVISliceInput[];
}

/** Options for {@link calibrateEssvi}. */
export interface ESSVICalibrationOptions {
  /** Curvature family; default `'power-law'`. */
  phi?: 'power-law' | 'heston';
  /**
   * Least-squares weighting of the total-variance residuals: `'uniform'` (default) or `'vega'` — weight each
   * point by its Black vega `∝ φ(d₁)·√t`, so liquid ATM/near-the-money strikes dominate the fit. Threaded
   * through the SSVI warm-start too.
   */
  weight?: 'uniform' | 'vega';
  /** Outer-search iteration budget (default 2,000, maximum 10,000). */
  maximumIterations?: number;
  /** Outer-search tolerance (default 1e-12). */
  tolerance?: number;
  /**
   * Warm start (Stage 4.5): a scalar `rho` broadcasts to every maturity knot, an array must match
   * the slice count; `phi.kind` must equal the calibration's `phi` family. A supplied start REPLACES
   * the internal SSVI warm start (echoed in `assumptions.initialParameters`).
   */
  initialParameters?: { rho: number | number[]; phi: SSVIPhi };
}

/** Result of {@link calibrateEssvi}. */
export interface ESSVICalibration {
  parameters: ESSVIParameters;
  /** Root-mean-square total-variance error across all points. */
  rmse: number;
  perSliceRmse: Array<{ timeToExpiryYears: number; rmse: number }>;
  /** The fitted skew term structure — the payoff of eSSVI over global-ρ SSVI. */
  rhoTerm: Array<{ timeToExpiryYears: number; rho: number }>;
  arbitrage: ESSVIArbitrage;
  converged: boolean;
  assumptions: {
    conventionsVersion: string;
    phi: 'power-law' | 'heston';
    skew: 'per-maturity';
    weight: 'uniform' | 'vega';
    /** Whether the search began from a caller-supplied start or the internal global-SSVI warm start. */
    initialParameters: 'supplied' | 'ssvi-warm-start';
  };
  diagnostics: Diagnostics;
}

const DEFAULT_G_GRID = Array.from({ length: 81 }, (_, i) => -1 + (2 * i) / 80);

// ─────────────────────────────── core ───────────────────────────────

/**
 * Generated closed-request specs (spec 3B.1b): allowlists projected from the declarations.
 * Resolved at module load so a stale key fails at import.
 */
function essviSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `essvi: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const CALIBRATE_ESSVI_SURFACE_SPEC = essviSpecOf('calibrateEssvi#0');
const CALIBRATE_ESSVI_OPTIONS_SPEC = essviSpecOf('calibrateEssvi#1');
const ESSVI_ARBITRAGE_PARAMETERS_SPEC = essviSpecOf('essviArbitrageFree#0');
const ESSVI_ARBITRAGE_OPTIONS_SPEC = essviSpecOf('essviArbitrageFree#1');
const ESSVI_TOTAL_VARIANCE_SPEC = essviSpecOf('essviTotalVariance#0');
const ESSVI_VOLATILITY_SPEC = essviSpecOf('essviVolatility#0');

/** A runnable diagnosis call — `essviArbitrageFree` takes (parameters, options?), not (…, k, t). */
const ESSVI_ARBITRAGE_EXAMPLE = (): string =>
  "essviArbitrageFree({ phi: { kind: 'power-law', eta: 1.0, gamma: 0.5 }, " +
  'thetaTerm: [{ timeToExpiryYears: 1, theta: 0.04, rho: -0.3 }] })';

/** A runnable surface-calibration call, complete enough to satisfy every fitting precondition. */
function essviCalibrationExampleCall(functionName: string): string {
  return (
    `${functionName}({ slices: [` +
    '{ timeToExpiryYears: 0.25, k: [-0.1, 0, 0.1], impliedVolatility: [0.22, 0.2, 0.21] }, ' +
    '{ timeToExpiryYears: 0.5, k: [-0.1, 0, 0.1], impliedVolatility: [0.23, 0.21, 0.22] }] })'
  );
}

/**
 * Interpolate `ρ(t)` linearly in `t` between knots; flat below the first and above the last (`ρ` can't be
 * extrapolated to `t = 0`). Mirrors `thetaAt` from `./ssvi.ts` for the skew.
 */
function rhoAt(thetaTerm: ESSVIParameters['thetaTerm'], timeToExpiryYears: number): number {
  const n = thetaTerm.length;
  if (timeToExpiryYears <= thetaTerm[0]!.timeToExpiryYears) return thetaTerm[0]!.rho;
  for (let i = 1; i < n; i++) {
    const hi = thetaTerm[i]!;
    if (timeToExpiryYears <= hi.timeToExpiryYears) {
      const lo = thetaTerm[i - 1]!;
      const frac =
        (timeToExpiryYears - lo.timeToExpiryYears) / (hi.timeToExpiryYears - lo.timeToExpiryYears);
      return lo.rho + frac * (hi.rho - lo.rho);
    }
  }
  return thetaTerm[n - 1]!.rho; // t beyond the last knot — flat.
}

/** A runnable call to the FAILING evaluator — eSSVI knots carry their own `rho`. */
function essviExampleCall(functionName: string): string {
  return (
    `${functionName}({ phi: { kind: 'power-law', eta: 1.0, gamma: 0.5 }, ` +
    'thetaTerm: [{ timeToExpiryYears: 1, theta: 0.04, rho: -0.3 }] }, 0, 1)'
  );
}

/**
 * The domain residue the generated spec cannot express: at least one knot, and each knot's own
 * shape and skew — the spec closes the CONTAINER; array elements stay curated teaching. Shape,
 * presence, finiteness, and the φ union's branches are the spec head's job now.
 */
function requireESSVIParams(parameters: ESSVIParameters, functionName: string): void {
  if (parameters.thetaTerm.length === 0) {
    throw new InputError(`${functionName}: parameters.thetaTerm must have at least one knot.`, {
      code: ErrorCode.InputOutOfRange,
      context: { knots: 0 },
    });
  }
  for (let i = 0; i < parameters.thetaTerm.length; i++) {
    const knot = parameters.thetaTerm[i]!;
    requireArgumentObject(functionName, `parameters.thetaTerm[${i}]`, knot as unknown);
    ensureFinite(knot.rho, `parameters.thetaTerm[${i}].rho`, functionName);
  }
}

/** Total implied variance `w(k, t)` on a calibrated eSSVI surface. */
export function essviTotalVariance(
  parameters: ESSVIParameters,
  k: number,
  timeToExpiryYears: number,
): number {
  const functionName = 'essviTotalVariance';
  validateClosedRequest(functionName, parameters, ESSVI_TOTAL_VARIANCE_SPEC, {
    argumentName: 'parameters',
    exampleCall: () => essviExampleCall(functionName),
  });
  requireESSVIParams(parameters, functionName);
  ensureFinite(k, 'k', functionName);
  if (!(timeToExpiryYears > 0)) {
    throw new InputError(
      `${functionName}: timeToExpiryYears must be positive; got ${timeToExpiryYears}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { timeToExpiryYears },
      },
    );
  }
  const theta = thetaAt(parameters.thetaTerm, timeToExpiryYears);
  const rho = rhoAt(parameters.thetaTerm, timeToExpiryYears);
  return ssviSliceWUnchecked({ k, theta, rho, psi: phiValueUnchecked(parameters.phi, theta) });
}

/** Implied volatility `√(w/t)` on a calibrated eSSVI surface. */
export function essviVolatility(
  parameters: ESSVIParameters,
  k: number,
  timeToExpiryYears: number,
): number {
  validateClosedRequest('essviVolatility', parameters, ESSVI_VOLATILITY_SPEC, {
    argumentName: 'parameters',
    exampleCall: () => essviExampleCall('essviVolatility'),
  });
  return Math.sqrt(essviTotalVariance(parameters, k, timeToExpiryYears) / timeToExpiryYears);
}

/** A `t`-grid spanning the knots, subdivided so intermediate-maturity crossings are caught. */
function defaultTGrid(thetaTerm: ESSVIParameters['thetaTerm']): number[] {
  const ts = thetaTerm.map((kn) => kn.timeToExpiryYears);
  const SUB = 6;
  const out: number[] = [];
  for (let i = 1; i < ts.length; i++) {
    const lo = ts[i - 1]!;
    const hi = ts[i]!;
    for (let s = 0; s < SUB; s++) out.push(lo + ((hi - lo) * s) / SUB);
  }
  out.push(ts[ts.length - 1]!); // the last knot (and the sole point for a 1-knot surface).
  return out;
}

/**
 * Diagnose the no-arbitrage status of an eSSVI surface: butterfly (exact Gatheral `g ≥ 0` at each grid
 * maturity, reducing the slice to raw SVI) and calendar (`w(k, t)` non-decreasing in `t` at every grid `k`,
 * scanned directly because θ-monotonicity is not sufficient once `ρ` varies). See the spec.
 */
export function essviArbitrageFree(
  parameters: ESSVIParameters,
  options: { grid?: number[]; maturityGrid?: number[] } = {},
): ESSVIArbitrage {
  const functionName = 'essviArbitrageFree';
  validateClosedRequest(functionName, parameters, ESSVI_ARBITRAGE_PARAMETERS_SPEC, {
    argumentName: 'parameters',
    exampleCall: ESSVI_ARBITRAGE_EXAMPLE,
  });
  validateClosedRequest(functionName, options, ESSVI_ARBITRAGE_OPTIONS_SPEC, {
    argumentName: 'options',
    exampleCall: ESSVI_ARBITRAGE_EXAMPLE,
  });
  requireESSVIParams(parameters, functionName);
  const grid = options.grid ?? DEFAULT_G_GRID;
  const maturityGrid = options.maturityGrid ?? defaultTGrid(parameters.thetaTerm);

  // The maturity terms depend on t ALONE. Interpolating them once here — rather than inside the
  // crossed (k, t) loop below — is not a micro-optimization: the calendar scan visits every maturity
  // once per grid point, so re-deriving θ(t), ρ(t) and φ(θ) down there repeated the same
  // interpolation `grid.length` times to produce identical numbers.
  const terms = maturityGrid.map((t) => {
    const theta = thetaAt(parameters.thetaTerm, t);
    const rho = rhoAt(parameters.thetaTerm, t);
    return { theta, rho, psi: phiValueUnchecked(parameters.phi, theta) };
  });

  // Butterfly: each grid maturity is an SSVI slice → reduce to SVI, test Gatheral g ≥ 0.
  let minG = Infinity;
  let butterfly = true;
  for (const term of terms) {
    // Unchecked kernel: the surface was validated at this head; re-validating per maturity is 3B.1b-1.
    const svi = ssviToSviUnchecked(term);
    // ONE sweep — `sviButterflyFree` IS `sviMinG(...) >= -1e-8`, so asking both walked the grid twice
    // per maturity to recover a boolean the number already carries.
    const knotMinG = sviMinG(svi, grid);
    if (!(knotMinG >= -1e-8)) butterfly = false;
    minG = Math.min(minG, knotMinG);
  }

  // Calendar: w(k, t) non-decreasing in t at every k on the grid (the definition of no calendar arb).
  let minSlope = Infinity;
  for (const k of grid) {
    let prevW = Number.NEGATIVE_INFINITY;
    for (const { theta, rho, psi } of terms) {
      const w = ssviSliceWUnchecked({ k, theta, rho, psi });
      if (prevW > Number.NEGATIVE_INFINITY) minSlope = Math.min(minSlope, w - prevW);
      prevW = w;
    }
  }

  return {
    calendarArbitrageFree: minSlope >= -1e-12,
    butterflyArbitrageFree: butterfly,
    minButterflyG: minG,
    minCalendarSlope: minSlope,
  };
}

// ─────────────────────────────── calibration ───────────────────────────────

/**
 * Fit a calendar-arbitrage-free eSSVI surface: θ knots from each slice's ATM variance (made monotone),
 * then per-maturity `ρᵢ` and a global `φ` by least squares — warm-started from a global SSVI fit, so eSSVI
 * begins at the best single-`ρ` surface and can only improve, with a calendar-crossing penalty keeping the
 * fit arbitrage-free between maturities. See the spec.
 */
export function calibrateEssvi(
  surface: ESSVICalibrationInput,
  options: ESSVICalibrationOptions = {},
): ESSVICalibration {
  const functionName = 'calibrateEssvi';
  validateClosedRequest(functionName, surface, CALIBRATE_ESSVI_SURFACE_SPEC, {
    argumentName: 'surface',
    subject: true,
    exampleCall: () => essviCalibrationExampleCall(functionName),
  });
  validateClosedRequest(functionName, options, CALIBRATE_ESSVI_OPTIONS_SPEC, {
    argumentName: 'options',
    exampleCall: () => essviCalibrationExampleCall(functionName),
  });
  requireCalibrationIterationBudget(functionName, options.maximumIterations);
  const phiKind = options.phi ?? 'power-law';
  const weightMode = options.weight ?? 'uniform';

  const prepared = prepareSlices(surface, functionName);
  const warnings: QuantWarning[] = [];

  // Non-decreasing θ backbone (clamp a data calendar arbitrage to the increasing hull + disclose).
  let clamped = false;
  let runningMax = 0;
  const thetas = prepared.map((p) => {
    let theta = p.theta;
    if (theta < runningMax) {
      theta = runningMax;
      clamped = true;
    }
    runningMax = theta;
    return theta;
  });
  if (clamped) {
    warnings.push(
      warning(
        WarningCode.VolatilityEssviCalendarData,
        `${functionName}: the raw ATM total-variance term structure was not non-decreasing (a calendar arbitrage in the data) — it was clamped to its increasing hull to keep the surface arbitrage-free.`,
        'warn',
      ),
    );
  }

  const m = prepared.length;
  const weights = calibrationWeights(prepared, weightMode);

  // The start: a caller-supplied `(ρ per knot, φ)` when given (Stage 4.5), else a global SSVI fit
  // with the same weighting — its ρ seeds every knot, its φ the curvature.
  const start = options.initialParameters;
  let x0: number[];
  if (start !== undefined) {
    requireSsviStart(functionName, start, phiKind, m);
    const rhos = Array.isArray(start.rho)
      ? [...start.rho]
      : prepared.map(() => start.rho as number);
    const phiParams0: number[] =
      start.phi.kind === 'power-law' ? [start.phi.eta, start.phi.gamma] : [start.phi.lambda];
    x0 = [...rhos, ...phiParams0];
  } else {
    const ssvi = calibrateSsvi(surface, {
      phi: phiKind,
      weight: weightMode,
      ...(options.maximumIterations !== undefined
        ? { maximumIterations: options.maximumIterations }
        : {}),
      ...(options.tolerance !== undefined ? { tolerance: options.tolerance } : {}),
    });
    const phi0 = ssvi.parameters.phi;
    const phiParams0: number[] = phi0.kind === 'power-law' ? [phi0.eta, phi0.gamma] : [phi0.lambda];
    x0 = [...prepared.map(() => ssvi.parameters.rho), ...phiParams0];
  }

  const buildPhi = (x: number[]): SSVIPhi =>
    phiKind === 'power-law'
      ? { kind: 'power-law', eta: x[m]!, gamma: x[m + 1]! }
      : { kind: 'heston', lambda: x[m]! };
  const feasible = (x: number[]): boolean => {
    for (let i = 0; i < m; i++) if (!(Math.abs(x[i]!) < 0.999)) return false;
    if (phiKind === 'power-law') return x[m]! > 1e-6 && x[m + 1]! > 1e-4 && x[m + 1]! < 0.9999;
    return x[m]! > 1e-6;
  };

  const PENALTY_W = 1e6; // total-variance SSE is ~1e-4; a crossing must dominate.
  const sse = (x: number[]): number => {
    if (!feasible(x)) return 1e12;
    const phi = buildPhi(x);
    const rhos = x.slice(0, m);
    let s = 0;
    for (let i = 0; i < m; i++) {
      const psi = phiValueUnchecked(phi, thetas[i]!);
      const sl = prepared[i]!;
      const wt = weights[i]!;
      for (let j = 0; j < sl.k.length; j++) {
        const d =
          ssviSliceWUnchecked({ k: sl.k[j]!, theta: thetas[i]!, rho: rhos[i]!, psi }) - sl.w[j]!;
        s += wt[j]! * d * d;
      }
    }
    // Calendar penalty: discourage w(k, θᵢ) > w(k, θᵢ₊₁) between adjacent knots on the density grid.
    for (let i = 1; i < m; i++) {
      const psiLo = phiValueUnchecked(phi, thetas[i - 1]!);
      const psiHi = phiValueUnchecked(phi, thetas[i]!);
      for (const k of DEFAULT_G_GRID) {
        const wLo = ssviSliceWUnchecked({
          k,
          theta: thetas[i - 1]!,
          rho: rhos[i - 1]!,
          psi: psiLo,
        });
        const wHi = ssviSliceWUnchecked({ k, theta: thetas[i]!, rho: rhos[i]!, psi: psiHi });
        if (wHi < wLo) s += PENALTY_W * (wLo - wHi) * (wLo - wHi);
      }
    }
    return s;
  };

  const res = nelderMead(sse, x0, {
    maximumIterations: options.maximumIterations ?? 2000,
    tolerance: options.tolerance ?? 1e-12,
  });
  const rhosFit = res.argMin.slice(0, m);
  const phi = buildPhi(res.argMin);
  const thetaTerm = prepared.map((p, i) => ({
    timeToExpiryYears: p.timeToExpiryYears,
    theta: thetas[i]!,
    rho: rhosFit[i]!,
  }));
  const parameters: ESSVIParameters = { phi, thetaTerm };

  // RMSE overall + per slice.
  let totalSq = 0;
  let totalN = 0;
  const perSliceRmse = prepared.map((sl, i) => {
    const psi = phiValueUnchecked(phi, thetas[i]!);
    let sq = 0;
    for (let j = 0; j < sl.k.length; j++) {
      const difference =
        ssviSliceWUnchecked({ k: sl.k[j]!, theta: thetas[i]!, rho: rhosFit[i]!, psi }) - sl.w[j]!;
      sq += difference * difference;
    }
    totalSq += sq;
    totalN += sl.k.length;
    return { timeToExpiryYears: sl.timeToExpiryYears, rmse: Math.sqrt(sq / sl.k.length) };
  });
  const rmse = Math.sqrt(totalSq / totalN);
  const rhoTerm = thetaTerm.map((kn) => ({ timeToExpiryYears: kn.timeToExpiryYears, rho: kn.rho }));

  const arbitrage = essviArbitrageFree(parameters);
  if (!arbitrage.butterflyArbitrageFree) {
    warnings.push(
      warning(
        WarningCode.VolatilityEssviButterfly,
        `${functionName}: the calibrated surface has butterfly arbitrage at one or more maturities (min Gatheral g = ${arbitrage.minButterflyG.toFixed(
          4,
        )} < 0) — the market data likely embeds it; treat the wings with caution.`,
        'warn',
      ),
    );
  }
  if (!arbitrage.calendarArbitrageFree) {
    warnings.push(
      warning(
        WarningCode.VolatilityEssviCalendar,
        `${functionName}: the calibrated surface still crosses in maturity (min Δw = ${arbitrage.minCalendarSlope.toExponential(
          2,
        )} < 0) — the per-maturity skews imply a residual calendar arbitrage the penalty could not fully remove.`,
        'warn',
      ),
    );
  }
  if (!res.converged) {
    warnings.push(
      warning(
        WarningCode.VolatilityEssviNotConverged,
        `${functionName}: the calibration search stopped without converging; treat the fit as approximate.`,
        'warn',
      ),
    );
  }

  return {
    parameters,
    rmse,
    perSliceRmse,
    rhoTerm,
    arbitrage,
    converged: res.converged,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      phi: phiKind,
      skew: 'per-maturity',
      weight: weightMode,
      initialParameters: start !== undefined ? 'supplied' : 'ssvi-warm-start',
    },
    diagnostics: {
      engine: 'essvi',
      method: `${start !== undefined ? 'supplied-start' : 'ssvi-warm-start'} + nelder-mead + ${phiKind}`,
      converged: res.converged,
      iterations: res.iterations,
      warnings,
    },
  };
}
