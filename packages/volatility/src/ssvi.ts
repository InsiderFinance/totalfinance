/**
 * SSVI — the Gatheral–Jacquier surface SVI (spec: `docs/specs/ssvi-surface.md`, roadmap Tier 2). Where
 * `calibrateSvi` fits one smile at a time (and independent slices can cross in maturity, an arbitrage the
 * per-slice fit can't see), SSVI parametrizes the WHOLE surface with the ATM total-variance term
 * structure `θ(t)`, a global skew `ρ`, and a curvature function `φ(θ)` — and is free of calendar
 * arbitrage by construction whenever `θ(t)` is non-decreasing.
 *
 *   w(k, θ) = (θ/2)·[ 1 + ρ·φ(θ)·k + √((φ(θ)·k + ρ)² + (1 − ρ²)) ],   θ = σ_ATM(t)²·t
 *
 * SSVI at a fixed θ IS a raw-SVI slice, so evaluation and the Gatheral-`g` butterfly density test reuse
 * `./svi.ts` rather than re-deriving them.
 */

import {
  type ClosedRequestSpecification,
  CONVENTIONS_VERSION,
  type Diagnostics,
  ErrorCode,
  InputError,
  type QuantWarning,
  ensureFinite,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
  validateClosedRequest,
  warning,
  WarningCode,
} from '@totalfinance/core';
import { nelderMead, normalPdf } from '@totalfinance/math';
import { type SVIParameters, sviMinG } from './svi.js';
import { requireCalibrationIterationBudget } from './calibration-limits.js';
import { requireSsviStart } from './calibration-start.js';
import {
  phiValueUnchecked,
  requirePhi,
  ssviSliceWUnchecked,
  ssviToSviUnchecked,
} from './ssvi-kernel.js';
import { VALIDATION_SPECS } from './generated/validation-specs.js';

/** The SSVI curvature function `φ(θ)`. */
export type SSVIPhi =
  | { kind: 'power-law'; eta: number; gamma: number }
  | { kind: 'heston'; lambda: number };

/** Calibrated SSVI surface parameters. */
export interface SSVIParameters {
  /** Global skew `ρ ∈ (−1, 1)`. */
  rho: number;
  /** Curvature function. */
  phi: SSVIPhi;
  /** ATM total-variance knots `(t, θ)`, strictly increasing in both (calendar-arbitrage-free). */
  thetaTerm: Array<{ timeToExpiryYears: number; theta: number }>;
}

/** One maturity slice of the market surface. */
export interface SSVISliceInput {
  /** Maturity in years. */
  timeToExpiryYears: number;
  /** Log-moneyness `ln(K/F)` per observation. */
  k: number[];
  /** Total variance `σ²·t` aligned to `k`. Provide this or `iv`. */
  w?: number[];
  /** Implied volatilities aligned to `k` (converted to `w = iv²·t`). Provide this or `w`. */
  impliedVolatility?: number[];
}

/** Input for {@link calibrateSsvi}. */
export interface SSVICalibrationInput {
  slices: SSVISliceInput[];
}

/** Options for {@link calibrateSsvi}. */
export interface SSVICalibrationOptions {
  /** Curvature family; default `'power-law'`. */
  phi?: 'power-law' | 'heston';
  /**
   * Least-squares weighting of the total-variance residuals: `'uniform'` (default) or `'vega'` — weight each
   * point by its Black vega `∝ φ(d₁)·√t`, so liquid ATM/near-the-money strikes dominate the fit and thin,
   * low-vega wings are downweighted.
   */
  weight?: 'uniform' | 'vega';
  /** Outer-search iteration budget (default 1,000, maximum 10,000). */
  maximumIterations?: number;
  /** Outer-search tolerance (default 1e-12). */
  tolerance?: number;
  /**
   * Warm start for the `(ρ, φ)` search (Stage 4.5): `phi.kind` must equal the calibration's `phi`
   * family. The θ knots are fixed from the data and are not a start.
   */
  initialParameters?: { rho: number; phi: SSVIPhi };
}

/** No-arbitrage diagnosis of an SSVI surface. */
export interface SSVIArbitrage {
  /** No calendar-spread arbitrage (θ non-decreasing + the ∂_θ(θφ) bound). */
  calendarArbitrageFree: boolean;
  /** No butterfly arbitrage — the exact Gatheral `g ≥ 0` density test at every θ-knot. */
  butterflyArbitrageFree: boolean;
  /** The minimum Gatheral `g(k)` over the grid and knots (`≥ 0` ⇔ butterfly-free). */
  minButterflyG: number;
  /** Whether the Gatheral–Jacquier SUFFICIENT conditions hold (guarantee arb-freedom for all `k`). */
  sufficientConditionsHold: boolean;
}

/** Result of {@link calibrateSsvi}. */
export interface SSVICalibration {
  parameters: SSVIParameters;
  /** Root-mean-square total-variance error across all points. */
  rmse: number;
  perSliceRmse: Array<{ timeToExpiryYears: number; rmse: number }>;
  arbitrage: SSVIArbitrage;
  converged: boolean;
  assumptions: {
    conventionsVersion: string;
    phi: 'power-law' | 'heston';
    weight: 'uniform' | 'vega';
    /** Whether the search began from a caller-supplied `initialParameters` or the built-in start. */
    initialParameters: 'supplied' | 'default';
  };
  diagnostics: Diagnostics;
}

/**
 * Per-point least-squares weights for a set of prepared slices: `1` (uniform) or the Black vega
 * `φ(d₁)·√t` at the market vol `σ = √(w/t)` (vega). The weights depend only on the market data, so they are
 * computed once and held fixed across the calibration search. A degenerate point (`w ≤ 0`) gets weight 0.
 */
export function calibrationWeights(
  slices: Array<{ timeToExpiryYears: number; k: number[]; w: number[] }>,
  weight: 'uniform' | 'vega',
): number[][] {
  requireArgumentArray('calibrationWeights', 'slices', slices);
  return slices.map((sl, i) => {
    requireArgumentObject('calibrationWeights', `slices[${i}]`, sl);
    requireArgumentArray('calibrationWeights', `slices[${i}].k`, sl.k);
    requireArgumentArray('calibrationWeights', `slices[${i}].w`, sl.w);
    return sl.k.map((k, j) => {
      if (weight === 'uniform') return 1;
      const wj = sl.w[j]!;
      if (!(wj > 0)) return 0;
      const sqrtT = Math.sqrt(sl.timeToExpiryYears);
      const sigma = Math.sqrt(wj / sl.timeToExpiryYears);
      const d1 = -k / (sigma * sqrtT) + 0.5 * sigma * sqrtT;
      return normalPdf(d1) * sqrtT;
    });
  });
}

// ─────────────────────────────── core ───────────────────────────────

/**
 * Generated closed-request specs (spec 3B.1b): allowlists projected from the declarations.
 * Resolved at module load so a stale key fails at import.
 */
function ssviSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `ssvi: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const CALIBRATE_SSVI_SURFACE_SPEC = ssviSpecOf('calibrateSsvi#0');
const CALIBRATE_SSVI_OPTIONS_SPEC = ssviSpecOf('calibrateSsvi#1');
const PREPARE_SLICES_SPEC = ssviSpecOf('prepareSlices#0');
const SSVI_ARBITRAGE_PARAMETERS_SPEC = ssviSpecOf('ssviArbitrageFree#0');
const SSVI_ARBITRAGE_OPTIONS_SPEC = ssviSpecOf('ssviArbitrageFree#1');
const PHI_VALUE_SPEC = ssviSpecOf('phiValue#0');
const SSVI_SLICE_SPEC = ssviSpecOf('ssviSliceW#0');
const SSVI_TO_SVI_SPEC = ssviSpecOf('ssviToSVI#0');
const SSVI_TOTAL_VARIANCE_SPEC = ssviSpecOf('ssviTotalVariance#0');
const SSVI_VOLATILITY_SPEC = ssviSpecOf('ssviVolatility#0');

/** A runnable diagnosis call — `ssviArbitrageFree` takes (parameters, options?), not (…, k, t). */
const SSVI_ARBITRAGE_EXAMPLE = (): string =>
  "ssviArbitrageFree({ rho: -0.3, phi: { kind: 'power-law', eta: 1.0, gamma: 0.5 }, " +
  'thetaTerm: [{ timeToExpiryYears: 1, theta: 0.04 }] })';

/** A runnable surface-calibration call, complete enough to satisfy every fitting precondition. */
function calibrationExampleCall(functionName: string): string {
  return (
    `${functionName}({ slices: [` +
    '{ timeToExpiryYears: 0.25, k: [-0.1, 0, 0.1], impliedVolatility: [0.22, 0.2, 0.21] }, ' +
    '{ timeToExpiryYears: 0.5, k: [-0.1, 0, 0.1], impliedVolatility: [0.23, 0.21, 0.22] }] })'
  );
}

/**
 * Evaluate the curvature `φ(θ)`. Shared with `./essvi.ts` (the eSSVI extension) so the two use one
 * definition. The unguarded arithmetic lives in `./ssvi-kernel.ts`, which the grid sweeps call.
 *
 * 3B.1b STOP: `phiValue#0`'s generated spec collapses the `SSVIPhi` union to its shared `kind`
 * field (a top-level spec carries no branches), so enforcing it would reject the union's own
 * `eta`/`gamma`/`lambda` as unknown fields. `requirePhi` remains the validation head here.
 */
export function phiValue(phi: SSVIPhi, theta: number): number {
  // The generated union spec closes each phi branch's key set (the unknown-key conviction);
  // requirePhi keeps its curated discriminant-first teaching beneath it.
  validateClosedRequest('phiValue', phi, PHI_VALUE_SPEC, {
    argumentName: 'phi',
    exampleCall: "phiValue({ kind: 'power-law', eta: 1, gamma: 0.5 }, 0.04)",
  });
  requirePhi(phi, 'phiValue');
  ensureFinite(theta, 'theta', 'phiValue');
  return phiValueUnchecked(phi, theta);
}

export interface SsviSliceInput {
  k: number;
  theta: number;
  rho: number;
  psi: number;
}

const SSVI_SLICE_EXAMPLE_CALL = 'ssviSliceW({ k: 0, theta: 0.04, rho: -0.3, psi: 1 })';

const SSVI_SLICE_HINTS: Record<string, string> = {
  k: 'log-moneyness ln(K/F)',
  theta: 'ATM total variance at this maturity',
  rho: 'global skew, in (-1, 1)',
  psi: 'curvature phi(theta)',
};

/** SSVI total variance at a fixed θ (the raw SSVI slice function). Shared with `./essvi.ts`. */
export function ssviSliceW(input: SsviSliceInput): number {
  validateClosedRequest('ssviSliceW', input, SSVI_SLICE_SPEC, {
    exampleCall: SSVI_SLICE_EXAMPLE_CALL,
    hints: SSVI_SLICE_HINTS,
  });
  const { k, theta, rho, psi } = input;
  return ssviSliceWUnchecked({ k, theta, rho, psi });
}

/**
 * Exact reduction of SSVI-at-θ to a raw-SVI slice, so `./svi.ts` evaluation and the Gatheral-`g`
 * butterfly test apply directly: `a = (θ/2)(1−ρ²)`, `b = θψ/2`, `ρ_svi = ρ`, `m = −ρ/ψ`,
 * `σ = √(1−ρ²)/ψ` (`ψ = φ(θ)`). Shared with `./essvi.ts`.
 */
export interface SsviToSviInput {
  theta: number;
  rho: number;
  psi: number;
}

export function ssviToSVI(input: SsviToSviInput): SVIParameters {
  validateClosedRequest('ssviToSVI', input, SSVI_TO_SVI_SPEC, {
    exampleCall: 'ssviToSVI({ theta: 0.04, rho: -0.3, psi: 1 })',
  });
  return ssviToSviUnchecked(input);
}

/**
 * Interpolate `θ(t)` linearly in `t` from the knots; `θ(0)=0`, flat beyond the last knot (constant total
 * variance — a decreasing vol). Monotone knots ⇒ monotone `θ(t)` ⇒ the time interpolation stays
 * calendar-arbitrage-free. Shared with `./essvi.ts` (its richer `{t,theta,rho}` knots are assignable).
 */
export function thetaAt(thetaTerm: SSVIParameters['thetaTerm'], timeToExpiryYears: number): number {
  requireArgumentArray('thetaAt', 'thetaTerm', thetaTerm);
  const n = thetaTerm.length;
  if (n === 0) {
    throw new InputError('thetaAt: thetaTerm must have at least one knot.', {
      code: ErrorCode.InputOutOfRange,
      context: { knots: 0 },
    });
  }
  const first = thetaTerm[0]!;
  if (timeToExpiryYears <= first.timeToExpiryYears)
    return (first.theta * timeToExpiryYears) / first.timeToExpiryYears;
  const last = thetaTerm[n - 1]!;
  if (timeToExpiryYears >= last.timeToExpiryYears) return last.theta;
  for (let i = 1; i < n; i++) {
    const hi = thetaTerm[i]!;
    if (timeToExpiryYears <= hi.timeToExpiryYears) {
      const lo = thetaTerm[i - 1]!;
      const frac =
        (timeToExpiryYears - lo.timeToExpiryYears) / (hi.timeToExpiryYears - lo.timeToExpiryYears);
      return lo.theta + frac * (hi.theta - lo.theta);
    }
  }
  return last.theta;
}

/** A runnable call to the FAILING evaluator, with a complete SSVI parameter object. */
function surfaceExampleCall(functionName: string): string {
  return (
    `${functionName}({ rho: -0.3, phi: { kind: 'power-law', eta: 1.0, gamma: 0.5 }, ` +
    'thetaTerm: [{ timeToExpiryYears: 1, theta: 0.04 }] }, 0, 1)'
  );
}

/**
 * The domain residue the generated spec cannot express: at least one θ-knot. Shape, presence,
 * field types, finiteness, the φ union's branches, and closedness are the spec head's job.
 */
function requireThetaKnots(parameters: SSVIParameters, functionName: string): void {
  if (parameters.thetaTerm.length === 0) {
    throw new InputError(`${functionName}: parameters.thetaTerm must have at least one knot.`, {
      code: ErrorCode.InputOutOfRange,
      context: { knots: 0 },
    });
  }
}

/** Total implied variance `w(k, t)` on a calibrated SSVI surface. */
export function ssviTotalVariance(
  parameters: SSVIParameters,
  k: number,
  timeToExpiryYears: number,
): number {
  const functionName = 'ssviTotalVariance';
  validateClosedRequest(functionName, parameters, SSVI_TOTAL_VARIANCE_SPEC, {
    argumentName: 'parameters',
    exampleCall: () => surfaceExampleCall(functionName),
  });
  requireThetaKnots(parameters, functionName);
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
  return ssviSliceWUnchecked({
    k,
    theta,
    rho: parameters.rho,
    psi: phiValueUnchecked(parameters.phi, theta),
  });
}

/** Implied volatility `√(w/t)` on a calibrated SSVI surface. */
export function ssviVolatility(
  parameters: SSVIParameters,
  k: number,
  timeToExpiryYears: number,
): number {
  validateClosedRequest('ssviVolatility', parameters, SSVI_VOLATILITY_SPEC, {
    argumentName: 'parameters',
    exampleCall: () => surfaceExampleCall('ssviVolatility'),
  });
  return Math.sqrt(ssviTotalVariance(parameters, k, timeToExpiryYears) / timeToExpiryYears);
}

const DEFAULT_G_GRID = Array.from({ length: 81 }, (_, i) => -1 + (2 * i) / 80);

/**
 * Diagnose the no-arbitrage status of an SSVI surface: calendar (θ non-decreasing + the ∂_θ(θφ) bound)
 * and butterfly (the exact Gatheral `g ≥ 0` density test at every θ-knot, plus the Gatheral–Jacquier
 * sufficient conditions). See the spec.
 */
export function ssviArbitrageFree(
  parameters: SSVIParameters,
  options: { grid?: number[] } = {},
): SSVIArbitrage {
  const functionName = 'ssviArbitrageFree';
  validateClosedRequest(functionName, parameters, SSVI_ARBITRAGE_PARAMETERS_SPEC, {
    argumentName: 'parameters',
    exampleCall: SSVI_ARBITRAGE_EXAMPLE,
  });
  validateClosedRequest(functionName, options, SSVI_ARBITRAGE_OPTIONS_SPEC, {
    argumentName: 'options',
    exampleCall: SSVI_ARBITRAGE_EXAMPLE,
  });
  requireThetaKnots(parameters, functionName);
  const grid = options.grid ?? DEFAULT_G_GRID;
  const { rho, phi, thetaTerm } = parameters;

  // Calendar: θ strictly increasing across the knots.
  let calendar = true;
  for (let i = 1; i < thetaTerm.length; i++) {
    if (!(thetaTerm[i]!.theta >= thetaTerm[i - 1]!.theta)) calendar = false;
  }
  // Calendar (φ side): 0 ≤ ∂_θ(θφ) ≤ (1/ρ²)(1+√(1−ρ²))·φ(θ) at each knot (auto-pass for ρ=0).
  const bound = rho === 0 ? Infinity : (1 / (rho * rho)) * (1 + Math.sqrt(1 - rho * rho));
  for (const knot of thetaTerm) {
    const th = knot.theta;
    const h = Math.max(1e-7, 1e-5 * th);
    const dThetaPhi =
      ((th + h) * phiValueUnchecked(phi, th + h) - (th - h) * phiValueUnchecked(phi, th - h)) /
      (2 * h);
    const phiTh = phiValueUnchecked(phi, th);
    if (!(dThetaPhi >= -1e-9 && dThetaPhi <= bound * phiTh + 1e-9)) calendar = false;
  }

  // Butterfly: exact g ≥ 0 on the reduced SVI slice at each knot + GJ sufficient conditions.
  let minG = Infinity;
  let butterfly = true;
  let sufficient = true;
  for (const knot of thetaTerm) {
    const psi = phiValueUnchecked(phi, knot.theta);
    // Unchecked kernel: the surface was validated at this head; re-validating per knot is 3B.1b-1.
    const svi = ssviToSviUnchecked({ theta: knot.theta, rho, psi });
    // ONE sweep. `sviButterflyFree` is `sviMinG(...) >= -1e-8`, so calling both walked the same grid
    // twice per knot to compute a boolean already implied by the number.
    const knotMinG = sviMinG(svi, grid);
    if (!(knotMinG >= -1e-8)) butterfly = false;
    minG = Math.min(minG, knotMinG);
    const c1 = knot.theta * psi * (1 + Math.abs(rho));
    const c2 = knot.theta * psi * psi * (1 + Math.abs(rho));
    if (!(c1 < 4 && c2 <= 4)) sufficient = false;
  }

  return {
    calendarArbitrageFree: calendar,
    butterflyArbitrageFree: butterfly,
    minButterflyG: minG,
    sufficientConditionsHold: sufficient,
  };
}

// ─────────────────────────────── calibration ───────────────────────────────

/** Linear interpolation of the (k, w) points evaluated at k = 0 (the ATM total variance). Shared with `./essvi.ts`. */
export function atmTotalVariance(k: number[], w: number[]): number {
  requireArgumentArray('atmTotalVariance', 'k', k);
  requireArgumentArray('atmTotalVariance', 'w', w);
  // Sort by k, then linear-interpolate at 0 (flat-extrapolate outside the range).
  const idx = k.map((_, i) => i).sort((a, b) => k[a]! - k[b]!);
  const ks = idx.map((i) => k[i]!);
  const ws = idx.map((i) => w[i]!);
  if (0 <= ks[0]!) return ws[0]!;
  const n = ks.length;
  if (0 >= ks[n - 1]!) return ws[n - 1]!;
  for (let i = 1; i < n; i++) {
    if (0 <= ks[i]!) {
      const frac = (0 - ks[i - 1]!) / (ks[i]! - ks[i - 1]!);
      return ws[i - 1]! + frac * (ws[i]! - ws[i - 1]!);
    }
  }
  return ws[n - 1]!;
}

/** A market slice with its total variances resolved and its ATM θ computed. Shared with `./essvi.ts`. */
export interface PreparedSlice {
  timeToExpiryYears: number;
  k: number[];
  w: number[];
  theta: number;
}

/**
 * Validate + resolve each slice's total variances (`w` or `iv²·t`), compute its ATM θ, and sort by
 * maturity. Shared with `./essvi.ts`, whose calibration input is the same `{ slices }` shape.
 */
export function prepareSlices(input: SSVICalibrationInput, functionName: string): PreparedSlice[] {
  if (typeof functionName !== 'string' || functionName.length === 0) {
    throw new InputError(
      `prepareSlices: functionName must be a non-empty string naming the calling boundary. Received ${functionName === null ? 'null' : functionName === undefined ? 'undefined' : typeof functionName}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'functionName' } },
    );
  }
  // The spec enforces `slices`' presence (its omit-required conviction was genuine) and the closed
  // key set; everything per-slice below stays curated teaching the spec cannot express.
  validateClosedRequest(functionName, input, PREPARE_SLICES_SPEC, {
    argumentName: 'surface',
    subject: true,
    exampleCall: () => calibrationExampleCall(functionName),
  });
  const slices = input.slices;
  if (slices.length < 2) {
    throw new InputError(
      `${functionName}: need ≥ 2 maturity slices to fit a surface; got ${slices.length}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { slices: slices.length },
      },
    );
  }
  const prepared: PreparedSlice[] = [];
  for (let s = 0; s < slices.length; s++) {
    const slice = slices[s]!;
    requireArgumentObject(functionName, `slices[${s}]`, slice);
    ensureKnownKeys(functionName, `slices[${s}]`, slice, [
      'timeToExpiryYears',
      'k',
      'w',
      'impliedVolatility',
    ]);
    if (!(slice.timeToExpiryYears > 0)) {
      throw new InputError(
        `${functionName}: slices[${s}].t must be positive; got ${slice.timeToExpiryYears}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { index: s, timeToExpiryYears: slice.timeToExpiryYears },
        },
      );
    }
    requireArgumentArray(functionName, `slices[${s}].k`, slice.k as unknown);
    const k = slice.k;
    let w: number[];
    if (slice.w !== undefined) {
      requireArgumentArray(functionName, `slices[${s}].w`, slice.w as unknown);
      w = slice.w;
    } else if (slice.impliedVolatility !== undefined) {
      requireArgumentArray(
        functionName,
        `slices[${s}].impliedVolatility`,
        slice.impliedVolatility as unknown,
      );
      w = slice.impliedVolatility.map((v) => v * v * slice.timeToExpiryYears);
    } else {
      throw new InputError(`${functionName}: slices[${s}] must provide w or impliedVolatility.`, {
        code: ErrorCode.InputMissingField,
        context: { index: s },
      });
    }
    if (k.length !== w.length) {
      throw new InputError(
        `${functionName}: slices[${s}] k and w/impliedVolatility must have the same length (${k.length} vs ${w.length}).`,
        { code: ErrorCode.InputOutOfRange, context: { index: s, k: k.length, w: w.length } },
      );
    }
    if (k.length < 3) {
      throw new InputError(`${functionName}: slices[${s}] needs ≥ 3 points; got ${k.length}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { index: s, points: k.length },
      });
    }
    for (let j = 0; j < k.length; j++) {
      ensureFinite(k[j]!, `slices[${s}].k[${j}]`, functionName);
      ensureFinite(w[j]!, `slices[${s}].w[${j}]`, functionName);
      if (!(w[j]! > 0)) {
        throw new InputError(
          `${functionName}: total variance must be positive; slices[${s}].w[${j}] = ${w[j]}.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { index: s, j, w: w[j] },
          },
        );
      }
    }
    prepared.push({
      timeToExpiryYears: slice.timeToExpiryYears,
      k,
      w,
      theta: atmTotalVariance(k, w),
    });
  }
  prepared.sort((a, b) => a.timeToExpiryYears - b.timeToExpiryYears);
  return prepared;
}

/**
 * Fit a calendar-arbitrage-free SSVI surface to a market total-variance surface: θ knots from each
 * slice's ATM variance (made monotone), then a global `ρ` and `φ`-parameters by least squares. See the
 * spec.
 */
export function calibrateSsvi(
  surface: SSVICalibrationInput,
  options: SSVICalibrationOptions = {},
): SSVICalibration {
  const functionName = 'calibrateSsvi';
  validateClosedRequest(functionName, surface, CALIBRATE_SSVI_SURFACE_SPEC, {
    argumentName: 'surface',
    subject: true,
    exampleCall: () => calibrationExampleCall(functionName),
  });
  validateClosedRequest(functionName, options, CALIBRATE_SSVI_OPTIONS_SPEC, {
    argumentName: 'options',
    exampleCall: () => calibrationExampleCall(functionName),
  });
  requireCalibrationIterationBudget(functionName, options.maximumIterations);
  const phiKind = options.phi ?? 'power-law';
  const weightMode = options.weight ?? 'uniform';
  const start = options.initialParameters;
  if (start !== undefined) requireSsviStart(functionName, start, phiKind);

  const prepared = prepareSlices(surface, functionName);
  const warnings: QuantWarning[] = [];

  // Enforce a non-decreasing θ term structure (calendar-arb-free by construction). A non-monotone raw
  // ATM structure is a data arbitrage — clamp to the running max and disclose.
  let clamped = false;
  let runningMax = 0;
  const thetaTerm = prepared.map((p) => {
    let theta = p.theta;
    if (theta < runningMax) {
      theta = runningMax;
      clamped = true;
    }
    runningMax = theta;
    return { timeToExpiryYears: p.timeToExpiryYears, theta };
  });
  if (clamped) {
    warnings.push(
      warning(
        WarningCode.VolatilitySsviCalendarData,
        `${functionName}: the raw ATM total-variance term structure was not non-decreasing (a calendar arbitrage in the data) — it was clamped to its increasing hull to keep the surface arbitrage-free.`,
        'warn',
      ),
    );
  }

  // Objective: (optionally vega-)weighted SSE of SSVI vs market total variance, with the θ knots fixed.
  // The weights use the market data only, so they are fixed across the search.
  const weights = calibrationWeights(prepared, weightMode);
  const thetas = thetaTerm.map((t) => t.theta);
  const buildPhi = (x: number[]): SSVIPhi =>
    phiKind === 'power-law'
      ? { kind: 'power-law', eta: x[1]!, gamma: x[2]! }
      : { kind: 'heston', lambda: x[1]! };
  const feasible = (x: number[]): boolean => {
    if (!(Math.abs(x[0]!) < 0.999)) return false;
    if (phiKind === 'power-law') return x[1]! > 1e-6 && x[2]! > 1e-4 && x[2]! < 0.9999;
    return x[1]! > 1e-6;
  };
  const sse = (x: number[]): number => {
    if (!feasible(x)) return 1e12;
    const rho = x[0]!;
    const phi = buildPhi(x);
    let s = 0;
    for (let i = 0; i < prepared.length; i++) {
      const psi = phiValueUnchecked(phi, thetas[i]!);
      const sl = prepared[i]!;
      const wt = weights[i]!;
      for (let j = 0; j < sl.k.length; j++) {
        const difference =
          ssviSliceWUnchecked({ k: sl.k[j]!, theta: thetas[i]!, rho, psi }) - sl.w[j]!;
        s += wt[j]! * difference * difference;
      }
    }
    return s;
  };

  const x0 =
    start !== undefined
      ? start.phi.kind === 'power-law'
        ? [start.rho, start.phi.eta, start.phi.gamma]
        : [start.rho, start.phi.lambda]
      : phiKind === 'power-law'
        ? [-0.2, 1.0, 0.5]
        : [-0.2, 1.0];
  const res = nelderMead(sse, x0, {
    maximumIterations: options.maximumIterations ?? 1000,
    tolerance: options.tolerance ?? 1e-12,
  });
  const rho = res.argMin[0]!;
  const phi = buildPhi(res.argMin);
  const parameters: SSVIParameters = { rho, phi, thetaTerm };

  // RMSE overall + per slice.
  let totalSq = 0;
  let totalN = 0;
  const perSliceRmse = prepared.map((sl, i) => {
    const psi = phiValueUnchecked(phi, thetas[i]!);
    let sq = 0;
    for (let j = 0; j < sl.k.length; j++) {
      const difference =
        ssviSliceWUnchecked({ k: sl.k[j]!, theta: thetas[i]!, rho, psi }) - sl.w[j]!;
      sq += difference * difference;
    }
    totalSq += sq;
    totalN += sl.k.length;
    return { timeToExpiryYears: sl.timeToExpiryYears, rmse: Math.sqrt(sq / sl.k.length) };
  });
  const rmse = Math.sqrt(totalSq / totalN);

  const arbitrage = ssviArbitrageFree(parameters);
  if (!arbitrage.butterflyArbitrageFree) {
    warnings.push(
      warning(
        WarningCode.VolatilitySsviButterfly,
        `${functionName}: the calibrated surface has butterfly arbitrage at one or more maturities (min Gatheral g = ${arbitrage.minButterflyG.toFixed(
          4,
        )} < 0) — the market data likely embeds it; treat the wings with caution.`,
        'warn',
      ),
    );
  }
  if (!res.converged) {
    warnings.push(
      warning(
        WarningCode.VolatilitySsviNotConverged,
        `${functionName}: the calibration search stopped without converging; treat the fit as approximate.`,
        'warn',
      ),
    );
  }

  return {
    parameters,
    rmse,
    perSliceRmse,
    arbitrage,
    converged: res.converged,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      phi: phiKind,
      weight: weightMode,
      initialParameters: start !== undefined ? 'supplied' : 'default',
    },
    diagnostics: {
      engine: 'ssvi',
      method: `nelder-mead + ${phiKind}`,
      converged: res.converged,
      iterations: res.iterations,
      warnings,
    },
  };
}
