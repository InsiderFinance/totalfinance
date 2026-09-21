/**
 * Linear-Gaussian Kalman filter and Rauch–Tung–Striebel smoother (spec §9.3).
 *
 * State-space model, with state dimension `n` and observation dimension `m`:
 *   - state:       `xₜ = F·xₜ₋₁ + wₜ`,  `wₜ ~ N(0, Q)`
 *   - observation: `zₜ = H·xₜ + vₜ`,     `vₜ ~ N(0, R)`
 * parameterised by `{ x0, P0, F, H, Q, R }` — the prior mean/covariance and the four system matrices.
 *
 * Built entirely on the package's own dense linear algebra ({@link cholesky}/{@link choleskySolve}):
 * the innovation covariance `S` and the predicted covariance are symmetric positive-definite, so the
 * Kalman gain, the RTS gain, the log-likelihood quadratic form, and `ln det S` all come from one
 * Cholesky factor — no explicit matrix inverse is formed.
 *
 * Honesty (design law #4): a missing observation is a first-class input (`null`, or a vector of `NaN`)
 * that triggers a pure prediction step (no update, no likelihood contribution) rather than a silent
 * zero-fill; an `±Infinity` observation is a data error and throws rather than being swallowed as
 * missing. Malformed dimensions or non-finite parameters throw `InputError`, and the covariances are
 * validated up front — `P0`/`Q` must be symmetric PSD and `R` symmetric PD — so an invalid noise model
 * is rejected even when the downstream innovation covariance would happen to stay positive definite.
 *
 * Example (pairs trading): a 2-state local-linear model of the hedge ratio `βₜ` between two assets —
 * `state = [β, β̇]`, `H = [xₜ, 0]` (the regressor is the second asset's price) — filters a
 * time-varying hedge ratio online; `kalmanSmooth` gives the retrospective full-sample estimate.
 */

import { ErrorCode, InputError } from '@totalfinance/core';
import type { Matrix } from './linalg.js';
import {
  cholesky,
  choleskySolve,
  jacobiEigen,
  matrixMultiply,
  matrixVectorProduct,
  pseudoInverse,
  transpose,
} from './linalg.js';

const LOG_2PI = Math.log(2 * Math.PI);

/** Linear-Gaussian state-space parameters. `n` = state dimension, `m` = observation dimension. */
export interface KalmanModel {
  /** Prior state mean `x₀`, length `n`. */
  x0: number[];
  /** Prior state covariance `P₀`, `n × n` (symmetric PSD). */
  P0: Matrix;
  /** State-transition matrix `F`, `n × n`. */
  F: Matrix;
  /** Observation matrix `H`, `m × n`. */
  H: Matrix;
  /** Process-noise covariance `Q`, `n × n` (symmetric PSD). */
  Q: Matrix;
  /** Observation-noise covariance `R`, `m × m` (symmetric PD). */
  R: Matrix;
}

/**
 * A single observation: an `m`-vector, a bare number (only when `m = 1`), or `null` / a vector
 * containing `NaN` to mark a MISSING observation (that step predicts only).
 */
export type KalmanObservation = number[] | number | null;

/** Forward-pass (filter) output. All arrays are length `T`, aligned to the observation sequence. */
export interface KalmanFilterResult {
  /** Filtered state means `x̂ₜ|ₜ` (`T × n`). */
  filteredStates: number[][];
  /** Filtered state covariances `Pₜ|ₜ`. */
  filteredCovariances: Matrix[];
  /** One-step predicted state means `x̂ₜ|ₜ₋₁` (`T × n`). */
  predictedStates: number[][];
  /** One-step predicted state covariances `Pₜ|ₜ₋₁`. */
  predictedCovariances: Matrix[];
  /** Innovations `zₜ − H·x̂ₜ|ₜ₋₁` (`null` at missing-observation steps). */
  innovations: (number[] | null)[];
  /** Innovation covariances `Sₜ = H·Pₜ|ₜ₋₁·Hᵀ + R` (`null` at missing steps). */
  innovationCovariances: (Matrix | null)[];
  /** Gaussian log-likelihood `Σₜ log N(zₜ; H·x̂ₜ|ₜ₋₁, Sₜ)`, summed over OBSERVED steps only. */
  logLikelihood: number;
  /** Number of steps that contributed to the likelihood (observed steps). */
  observedCount: number;
  /** State dimension. */
  stateDimension: number;
  /** Observation dimension. */
  observationDimension: number;
}

/** RTS-smoother output — the filter result plus the backward-smoothed estimates. */
export interface KalmanSmoothResult extends KalmanFilterResult {
  /** Smoothed state means `x̂ₜ|T` using all `T` observations (`T × n`). */
  smoothedStates: number[][];
  /** Smoothed state covariances `Pₜ|T`. */
  smoothedCovariances: Matrix[];
}

// ───────────────────────── small matrix/vector helpers ─────────────────────────

function isSquare(A: Matrix, size: number): boolean {
  if (A.length !== size) return false;
  for (const row of A) if (row.length !== size) return false;
  return true;
}

function requireFiniteMatrix(A: Matrix, name: string): void {
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < A[i]!.length; j++) {
      if (!Number.isFinite(A[i]![j]!)) {
        throw new InputError(`kalman: ${name}[${i}][${j}] is not finite.`, {
          code: ErrorCode.InputNotFinite,
          context: { name, row: i, col: j },
        });
      }
    }
  }
}

function addMat(A: Matrix, B: Matrix): Matrix {
  return A.map((row, i) => row.map((v, j) => v + B[i]![j]!));
}

function subMat(A: Matrix, B: Matrix): Matrix {
  return A.map((row, i) => row.map((v, j) => v - B[i]![j]!));
}

/** Force exact symmetry to damp round-off drift in a covariance update. */
function symmetrize(A: Matrix): Matrix {
  const n = A.length;
  const out: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) out[i]![j] = 0.5 * (A[i]![j]! + A[j]![i]!);
  }
  return out;
}

function logDetFromChol(L: Matrix): number {
  let s = 0;
  for (let i = 0; i < L.length; i++) s += Math.log(L[i]![i]!);
  return 2 * s;
}

// ───────────────────────── validation ─────────────────────────

/** Reject a covariance matrix that is not (numerically) symmetric. */
function requireSymmetric(A: Matrix, name: string): void {
  const n = A.length;
  let maxAbs = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) maxAbs = Math.max(maxAbs, Math.abs(A[i]![j]!));
  const tolerance = 1e-9 * (maxAbs || 1);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(A[i]![j]! - A[j]![i]!) > tolerance) {
        throw new InputError(
          `kalman: ${name} must be symmetric (entry [${i}][${j}]=${A[i]![j]} ≠ [${j}][${i}]=${A[j]![i]}); a covariance is symmetric by definition.`,
          { code: ErrorCode.InputOutOfRange, context: { matrix: name, i, j } },
        );
      }
    }
  }
}

/** Min eigenvalue and eigen-scale of a symmetric matrix (after enforcing symmetry). */
function eigenBounds(A: Matrix, name: string): { min: number; scale: number } {
  requireSymmetric(A, name);
  const { values } = jacobiEigen(symmetrize(A));
  return {
    min: Math.min(...values),
    scale: Math.max(...values.map((v) => Math.abs(v))),
  };
}

/**
 * Require a symmetric covariance to be positive-SEMI-definite (allows zero eigenvalues — a
 * deterministic state component has zero process noise). A negative eigenvalue is not a valid
 * covariance and is rejected rather than silently producing a nonsensical filter.
 */
function requirePsd(A: Matrix, name: string): void {
  const { min, scale } = eigenBounds(A, name);
  if (min < -1e-9 * (scale || 1)) {
    throw new InputError(
      `kalman: ${name} must be positive semi-definite (min eigenvalue ${min}); it is not a valid covariance.`,
      { code: ErrorCode.LinalgNotPositiveDefinite, context: { matrix: name, minEigenvalue: min } },
    );
  }
}

/**
 * Require the observation-noise covariance `R` to be positive-DEFINITE. The innovation covariance
 * `S = H P Hᵀ + R` must be invertible for the Kalman gain to exist; a negative or singular `R` can
 * accidentally leave `S` PD on some steps yet is not itself a valid noise model, so we reject it up
 * front rather than trusting the downstream Cholesky to happen to catch it.
 */
function requirePd(A: Matrix, name: string): void {
  const { min, scale } = eigenBounds(A, name);
  if (min <= 1e-12 * (scale || 1)) {
    throw new InputError(
      `kalman: ${name} must be positive definite (min eigenvalue ${min}); the innovation covariance would be singular.`,
      { code: ErrorCode.LinalgNotPositiveDefinite, context: { matrix: name, minEigenvalue: min } },
    );
  }
}

function validateModel(model: KalmanModel): { n: number; m: number } {
  const n = model.x0.length;
  if (n === 0) {
    throw new InputError('kalman: x0 must be non-empty (state dimension ≥ 1).', {
      code: ErrorCode.InputOutOfRange,
      context: { stateDimension: n },
    });
  }
  const m = model.H.length;
  if (m === 0) {
    throw new InputError('kalman: H must have at least one row (observation dimension ≥ 1).', {
      code: ErrorCode.InputOutOfRange,
      context: { m },
    });
  }
  if (!isSquare(model.F, n)) throw dimError('F', `${n}×${n}`);
  if (!isSquare(model.P0, n)) throw dimError('P0', `${n}×${n}`);
  if (!isSquare(model.Q, n)) throw dimError('Q', `${n}×${n}`);
  if (!isSquare(model.R, m)) throw dimError('R', `${m}×${m}`);
  for (let i = 0; i < m; i++) {
    if (model.H[i]!.length !== n) throw dimError('H', `${m}×${n}`);
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(model.x0[i]!)) {
      throw new InputError(`kalman: x0[${i}] is not finite.`, {
        code: ErrorCode.InputNotFinite,
        context: { index: i },
      });
    }
  }
  requireFiniteMatrix(model.F, 'F');
  requireFiniteMatrix(model.P0, 'P0');
  requireFiniteMatrix(model.Q, 'Q');
  requireFiniteMatrix(model.R, 'R');
  requireFiniteMatrix(model.H, 'H');
  // A covariance must be a valid covariance: prior/process noise symmetric PSD, observation noise PD.
  requirePsd(model.P0, 'P0');
  requirePsd(model.Q, 'Q');
  requirePd(model.R, 'R');
  return { n, m };
}

function dimError(name: string, expected: string): InputError {
  return new InputError(`kalman: ${name} has the wrong shape (expected ${expected}).`, {
    code: ErrorCode.InputOutOfRange,
    context: { matrix: name, expected },
  });
}

/** Normalise one observation to an `m`-vector, or `null` when it is missing (null / any NaN). */
function normalizeObservation(z: KalmanObservation, m: number, t: number): number[] | null {
  if (z === null) return null;
  const vec = typeof z === 'number' ? [z] : z;
  if (vec.length !== m) {
    throw new InputError(
      `kalman: observation ${t} has length ${vec.length}, expected ${m}.` +
        (typeof z === 'number' && m !== 1 ? ' (a bare number is only allowed when m = 1)' : ''),
      { code: ErrorCode.InputOutOfRange, context: { index: t, got: vec.length, expected: m } },
    );
  }
  let missing = false;
  for (const v of vec) {
    if (Number.isNaN(v)) {
      missing = true; // NaN is the documented MISSING marker
    } else if (!Number.isFinite(v)) {
      // ±Infinity is a data error, not a missing marker — silently dropping it would hide bad input.
      throw new InputError(
        `kalman: observation ${t} contains a non-finite value (${v}); use null or NaN to mark a MISSING observation, not ±Infinity.`,
        { code: ErrorCode.InputNotFinite, context: { index: t, value: v } },
      );
    }
  }
  return missing ? null : vec.slice();
}

// ───────────────────────── the filter ─────────────────────────

/**
 * Run the forward Kalman recursion over `observations`. Each step predicts `xₜ|ₜ₋₁` from the previous
 * filtered state, then (when the observation is present) updates to `xₜ|ₜ` and accumulates the Gaussian
 * log-likelihood. Missing observations predict only.
 */
export function kalmanFilter(
  model: KalmanModel,
  observations: KalmanObservation[],
): KalmanFilterResult {
  const { n, m } = validateModel(model);
  const T = observations.length;
  if (T === 0) {
    throw new InputError('kalman: observations must be non-empty.', {
      code: ErrorCode.InputOutOfRange,
      context: { T },
    });
  }
  const { F, H, Q, R } = model;
  const Ht = transpose(H);
  const Ft = transpose(F);

  const filteredStates: number[][] = [];
  const filteredCovariances: Matrix[] = [];
  const predictedStates: number[][] = [];
  const predictedCovariances: Matrix[] = [];
  const innovations: (number[] | null)[] = [];
  const innovationCovariances: (Matrix | null)[] = [];
  let logLikelihood = 0;
  let observedCount = 0;

  let xPrev = model.x0.slice();
  let PPrev = symmetrize(model.P0);

  for (let t = 0; t < T; t++) {
    // Predict.
    const xPred = matrixVectorProduct(F, xPrev);
    const PPred = symmetrize(addMat(matrixMultiply(matrixMultiply(F, PPrev), Ft), Q));
    predictedStates.push(xPred.slice());
    predictedCovariances.push(PPred);

    const z = normalizeObservation(observations[t]!, m, t);
    if (z === null) {
      // No measurement — the filtered estimate is the prediction.
      filteredStates.push(xPred.slice());
      filteredCovariances.push(PPred);
      innovations.push(null);
      innovationCovariances.push(null);
      xPrev = xPred;
      PPrev = PPred;
      continue;
    }

    // Update.
    const Hx = matrixVectorProduct(H, xPred); // m
    const y = z.map((zi, i) => zi - Hx[i]!); // innovation, m
    const PHt = matrixMultiply(PPred, Ht); // n × m
    const S = symmetrize(addMat(matrixMultiply(H, PHt), R)); // m × m
    const cholS = cholesky(S); // throws if not PD (design law #4)

    // Kalman gain K (n × m): row i solves S·K[i]ᵀ = (PHt)[i].
    const K: Matrix = PHt.map((rowI) => choleskySolve(cholS, rowI));
    // Filtered state: xPred + K·y.
    const Ky = matrixVectorProduct(K, y);
    const xFilt = xPred.map((xi, i) => xi + Ky[i]!);
    // Covariance: Pₜ|ₜ = PPred − K·(H·PPred).
    const HPPred = matrixMultiply(H, PPred); // m × n
    const PFilt = symmetrize(subMat(PPred, matrixMultiply(K, HPPred)));

    filteredStates.push(xFilt);
    filteredCovariances.push(PFilt);
    innovations.push(y);
    innovationCovariances.push(S);

    // Log-likelihood: −½(m·ln2π + ln|S| + yᵀS⁻¹y).
    const Sinv_y = choleskySolve(cholS, y);
    let quad = 0;
    for (let i = 0; i < m; i++) quad += y[i]! * Sinv_y[i]!;
    logLikelihood += -0.5 * (m * LOG_2PI + logDetFromChol(cholS) + quad);
    observedCount += 1;

    xPrev = xFilt;
    PPrev = PFilt;
  }

  return {
    filteredStates,
    filteredCovariances,
    predictedStates,
    predictedCovariances,
    innovations,
    innovationCovariances,
    logLikelihood,
    observedCount,
    stateDimension: n,
    observationDimension: m,
  };
}

/**
 * The Gaussian log-likelihood of `observations` under `model` — the innovation-form likelihood from
 * the forward pass. This is the objective to maximise when calibrating `{ F, H, Q, R }` (e.g. by a
 * Nelder–Mead search over a parameterisation of the system matrices).
 */
export function kalmanLogLikelihood(model: KalmanModel, observations: KalmanObservation[]): number {
  return kalmanFilter(model, observations).logLikelihood;
}

/**
 * The RTS backward gain `Cₜ = A·(Pₜ₊₁|ₜ)⁻¹`, with `A = Pₜ|ₜ·Fᵀ`.
 *
 * `Pₜ₊₁|ₜ` is positive-SEMI-definite, not positive-definite: {@link validateModel} deliberately
 * accepts `Q` (and `P0`) with zero eigenvalues, because a deterministic state component — a constant
 * level, a fixed drift, the whole `Q = [[0]]` local-level model in this file's own test suite — has
 * exactly zero process noise. The Cholesky path then failed on a model the validator had just
 * approved, and did it with `cholesky: matrix is not positive definite (pivot 0 at 0)`: an error from
 * two layers down, naming neither the smoother nor the model.
 *
 * So: Cholesky while the predicted covariance is PD (fast, and the exact solve), and the
 * Moore–Penrose pseudoinverse when it is singular. On a singular `Pₜ₊₁|ₜ` the pseudoinverse gives the
 * minimum-norm gain — zero along the deterministic directions, which is the mathematically right
 * answer there: a component with no process noise has nothing for the backward pass to correct, so
 * the smoothed estimate coincides with the filtered one.
 */
function rtsGain(A: Matrix, predictedNext: Matrix): Matrix {
  try {
    const cholPp = cholesky(predictedNext);
    // Row i solves Pₜ₊₁|ₜ·Cᵀ[·,i] = A[i] (the predicted covariance is symmetric).
    return A.map((rowI) => choleskySolve(cholPp, rowI));
  } catch {
    return matrixMultiply(A, pseudoInverse(predictedNext));
  }
}

/**
 * Rauch–Tung–Striebel fixed-interval smoother. Runs the forward filter, then a backward pass giving
 * `xₜ|T` / `Pₜ|T` — the state estimates conditioned on the WHOLE sample, always at least as sharp as
 * the filtered estimates. The backward gain is `Cₜ = Pₜ|ₜ·Fᵀ·(Pₜ₊₁|ₜ)⁻¹`, solved through the Cholesky
 * factor of the predicted covariance — or, when that covariance is singular because the model has a
 * deterministic component, through its pseudoinverse (see {@link rtsGain}).
 */
export function kalmanSmooth(
  model: KalmanModel,
  observations: KalmanObservation[],
): KalmanSmoothResult {
  const filter = kalmanFilter(model, observations);
  const { filteredStates, filteredCovariances, predictedStates, predictedCovariances } = filter;
  const T = filteredStates.length;
  const Ft = transpose(model.F);

  const smoothedStates: number[][] = new Array(T);
  const smoothedCovariances: Matrix[] = new Array(T);
  // Terminal step: the smoothed estimate equals the filtered estimate.
  smoothedStates[T - 1] = filteredStates[T - 1]!.slice();
  smoothedCovariances[T - 1] = filteredCovariances[T - 1]!;

  for (let t = T - 2; t >= 0; t--) {
    const Pf = filteredCovariances[t]!; // Pₜ|ₜ
    const PpNext = predictedCovariances[t + 1]!; // Pₜ₊₁|ₜ (symmetric PSD)
    const A = matrixMultiply(Pf, Ft); // n × n = Pₜ|ₜ·Fᵀ
    const C: Matrix = rtsGain(A, PpNext); // backward gain Cₜ

    const xsNext = smoothedStates[t + 1]!;
    const xpNext = predictedStates[t + 1]!;
    const dx = xsNext.map((v, i) => v - xpNext[i]!);
    const Cdx = matrixVectorProduct(C, dx);
    smoothedStates[t] = filteredStates[t]!.map((v, i) => v + Cdx[i]!);

    const PsNext = smoothedCovariances[t + 1]!;
    const dP = subMat(PsNext, PpNext); // Pₜ₊₁|T − Pₜ₊₁|ₜ
    const CdPCt = matrixMultiply(matrixMultiply(C, dP), transpose(C));
    smoothedCovariances[t] = symmetrize(addMat(Pf, CdPCt));
  }

  return { ...filter, smoothedStates, smoothedCovariances };
}
