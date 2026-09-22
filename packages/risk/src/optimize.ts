/**
 * Portfolio optimization: min-variance, max-Sharpe (tangency), mean-variance utility, risk parity
 * (equal risk contribution), Hierarchical Risk Parity (HRP), and Kelly.
 *
 * Unconstrained / budget-only problems use the analytic `Σ⁻¹` solutions. Adding inequality
 * constraints (long-only, per-asset bounds) switches to a **projected-gradient** solver on the convex
 * objective, projecting each step onto `{ aᵀw = c, lo ≤ w ≤ hi }` via a 1-D dual bisection. Risk
 * parity uses the standard cyclical fixed-point; HRP uses correlation-distance clustering +
 * recursive bisection. All portfolios are fully invested (`Σw = budget`, default 1) unless noted.
 */

import { ensureFiniteWhenPresent } from './options-internal.js';
import {
  CONVENTIONS_VERSION,
  type Computed,
  ensureFinite,
  ErrorCode,
  InputError,
  type QuantWarning,
  warning,
  requireArgumentArray,
  requireRepresentableResult,
  WarningCode,
} from '@totalfinance/core';
import { type Matrix, jacobiEigen } from '@totalfinance/math';
import { dot, matVec, quadForm, assertSquare, spdInverse } from './linalg.js';
import { snapshotFiniteVector } from './numeric-vector.js';
import { describeInputValue } from './input-description.js';
import {
  OPTIMIZE_CONSTRAINTS_KEYS,
  requireClosedDataObject,
  requireDenseDataArray,
  validateOptimizeConstraints,
} from './optimizer-validation.js';

// The efficient frontier composes the solvers below (FC7 slice 4) and rides on this entrypoint so
// `@insiderfinance/totalfinance/risk/optimize` carries the whole mean-variance family. `frontier.ts` imports the
// public facades from this module; the cycle is import-time safe because nothing here is read
// during module evaluation.
export { efficientFrontier } from './frontier.js';
export type {
  EfficientFrontierConstraints,
  EfficientFrontierGrid,
  EfficientFrontierGridKind,
  EfficientFrontierInput,
  EfficientFrontierResult,
  EfficientFrontierValue,
  FrontierPoint,
  FrontierPortfolio,
} from './frontier.js';

/** A sector/group exposure cap: the listed asset indices must sum within `[min, max]`. */
export interface GroupConstraint {
  /** Asset indices belonging to the group. */
  members: number[];
  /** Minimum aggregate weight for the group (default `-Infinity`). */
  min?: number;
  /** Maximum aggregate weight for the group (default `+Infinity`). */
  max?: number;
}

/** A turnover budget relative to a base (current) portfolio: `Σ|w − previousWeights| ≤ max`. */
export interface TurnoverConstraint {
  /** Current weights to measure turnover against. */
  previousWeights: number[];
  /** Maximum one-way + reverse (L1) turnover allowed. */
  max: number;
}

export interface OptimizeConstraints {
  /** Forbid short positions (`w ≥ 0`). Ignored where `bounds` is given. */
  longOnly?: boolean;
  /** Per-asset `[lo, hi]` bounds. */
  bounds?: [number, number][];
  /** Sum-to budget (`Σw`). Default 1 (fully invested). */
  budget?: number;
  /** Sector/group exposure caps (`min ≤ Σ_group w ≤ max`). */
  groups?: GroupConstraint[];
  /** Turnover budget against a base portfolio (`Σ|w − previousWeights| ≤ max`). */
  turnover?: TurnoverConstraint;
  /**
   * Linear transaction cost charged on the trade away from a base portfolio. Subtracted from the
   * objective as `Σ perUnitTurnover_i·|w_i − previousWeights_i|` (a scalar applies to every asset). Needs `previousWeights`.
   */
  transactionCosts?: { perUnitTurnover: number | number[]; previousWeights: number[] };
  /** Projected-gradient iteration cap. Default 5000. */
  maximumIterations?: number;
  /** Projected-gradient convergence tolerance on the weight step. Default 1e-11. */
  tolerance?: number;
}

/** Internal solver output — reshaped into the public Computed envelope by `envelope()` (dx §2.4). */
interface SolverOutput {
  weights: number[];
  /** Objective at the solution (variance / Sharpe / utility / etc. — documented per function). */
  objective: number;
  iterations: number;
  converged: boolean;
  /** Why the solver stopped when `converged` is false (e.g. `infeasible_tangency`, `max_iterations`). */
  reason?: string;
  /** Method disclosure when a fallback replaced the requested solver (e.g. `min_variance_fallback`). */
  method?: string;
  /** Structured warnings (e.g. an infeasibility explanation). */
  warnings?: QuantWarning[];
}

/**
 * The public optimizer result (dx §2.4): the core `Computed` envelope. `value` carries the weights
 * and the objective at the solution; `assumptions` echo which objective ran and the budget;
 * `diagnostics` carry `converged` / `iterations` and all warnings — a non-converged run adds an
 * `optimize.not_converged` warning naming the solver's stop reason instead of hoisting a bespoke
 * `reason` field.
 */
export type OptimizeResult = Computed<
  { weights: number[]; objective: number },
  { objective: string; budget: number }
>;

/** Reshape a solver output into the public envelope. */
function envelope(objective: string, budget: number, s: SolverOutput): OptimizeResult {
  const warnings = [...(s.warnings ?? [])];
  if (!s.converged) {
    warnings.push(
      warning(
        WarningCode.OptimizeNotConverged,
        `${objective}: solver stopped without converging${
          s.reason !== undefined ? ` (${s.reason})` : ''
        } — treat the weights as untrustworthy.`,
        'warn',
        s.reason !== undefined ? { reason: s.reason } : undefined,
      ),
    );
  }
  const result: OptimizeResult = {
    value: { weights: s.weights, objective: s.objective },
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, objective, budget },
    diagnostics: {
      converged: s.converged,
      iterations: s.iterations,
      warnings,
      ...(s.method !== undefined ? { method: s.method } : {}),
    },
  };
  return requireRepresentableResult(objective, result);
}

function ones(n: number): number[] {
  return new Array<number>(n).fill(1);
}
function scaleToSum(w: number[], s: number): number[] {
  const total = w.reduce((a, b) => a + b, 0);
  return total === 0 ? w : w.map((x) => (x * s) / total);
}
function resolveBounds(n: number, c: OptimizeConstraints): { lo: number[]; hi: number[] } {
  if (c.bounds) {
    if (c.bounds.length !== n) {
      throw new InputError('optimize: bounds length must match the number of assets.', {
        code: ErrorCode.InputOutOfRange,
        context: { expected: n, got: c.bounds.length },
      });
    }
    // Reject NaN endpoints (would leak NaN weights) and inverted boxes `lo > hi` (empty feasible set
    // that the clamp would silently resolve to a bound-violating value). ±Infinity stays valid.
    for (let i = 0; i < n; i++) {
      const lo = c.bounds[i]![0];
      const hi = c.bounds[i]![1];
      if (Number.isNaN(lo) || Number.isNaN(hi)) {
        throw new InputError(`optimize: bounds[${i}] must not contain NaN, got [${lo}, ${hi}].`, {
          code: ErrorCode.InputNotFinite,
          context: { index: i, lowerBound: lo, upperBound: hi },
        });
      }
      if (lo === Number.POSITIVE_INFINITY) {
        throw new InputError(
          `optimize: bounds[${i}] lower bound must be finite or -Infinity, never +Infinity.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { index: i, lowerBound: lo, upperBound: hi },
          },
        );
      }
      if (hi === Number.NEGATIVE_INFINITY) {
        throw new InputError(
          `optimize: bounds[${i}] upper bound must be finite or +Infinity, never -Infinity.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { index: i, lowerBound: lo, upperBound: hi },
          },
        );
      }
      if (lo > hi) {
        throw new InputError(
          `optimize: bounds[${i}] lower (${lo}) must not exceed upper (${hi}).`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { index: i, lowerBound: lo, upperBound: hi },
          },
        );
      }
    }
    return { lo: c.bounds.map((b) => b[0]), hi: c.bounds.map((b) => b[1]) };
  }
  const lo = c.longOnly ? 0 : Number.NEGATIVE_INFINITY;
  return {
    lo: new Array<number>(n).fill(lo),
    hi: new Array<number>(n).fill(Number.POSITIVE_INFINITY),
  };
}
const hasInequality = (c: OptimizeConstraints): boolean =>
  Boolean(c.longOnly || c.bounds || c.groups?.length || c.turnover || c.transactionCosts);

/** Validate the complete shared constraint grammar before any kernel reads it. */
function validateConstraints(c: OptimizeConstraints, functionName: string, n?: number): void {
  validateOptimizeConstraints(c, functionName, n);
}

/**
 * Maximum absolute violation of the feasible set by `w` (0 ⇒ feasible within tolerance): the budget
 * equality, the box, every group cap, the turnover budget, and an optional minimum-return floor. Used
 * to downgrade `converged` to false when the projected solution lands outside an (e.g. empty) feasible
 * region — never report success on an infeasible portfolio.
 */
function maxConstraintViolation(
  w: number[],
  budget: number,
  lo: number[],
  hi: number[],
  c: OptimizeConstraints,
  extra?: { mu: number[]; minReturn: number },
): number {
  let sum = 0;
  for (let i = 0; i < w.length; i++) {
    if (!Number.isFinite(w[i]!)) return Infinity;
    sum += w[i]!;
  }
  let v = Math.abs(sum - budget);
  for (let i = 0; i < w.length; i++) v = Math.max(v, lo[i]! - w[i]!, w[i]! - hi[i]!);
  for (const g of c.groups ?? []) {
    let s = 0;
    for (const m of g.members) s += w[m]!;
    if (g.max !== undefined) v = Math.max(v, s - g.max);
    if (g.min !== undefined) v = Math.max(v, g.min - s);
  }
  if (c.turnover) {
    let t = 0;
    for (let i = 0; i < w.length; i++) t += Math.abs(w[i]! - c.turnover.previousWeights[i]!);
    v = Math.max(v, t - c.turnover.max);
  }
  if (extra) v = Math.max(v, extra.minReturn - dot(extra.mu, w));
  return v;
}

/** Tolerance below which `maxConstraintViolation` counts a portfolio as feasible. */
const FEASIBILITY_TOL = 1e-6;

/**
 * Whether the box-and-budget feasible set `{ lo ≤ w ≤ hi, Σw = budget }` is non-empty: it is iff
 * `Σ lo ≤ budget ≤ Σ hi`. (E.g. two assets each capped at 0.4 cannot sum to a budget of 1.)
 */
function boxBudgetFeasible(lo: number[], hi: number[], budget: number): boolean {
  let sumLo = 0;
  let sumHi = 0;
  for (let i = 0; i < lo.length; i++) {
    sumLo += lo[i]!;
    sumHi += hi[i]!;
  }
  const eps = 1e-9;
  return sumLo <= budget + eps && budget <= sumHi + eps;
}

/** An infeasible-constraints result: best-effort projected weights, but `converged: false` (never a fabricated success). */
function infeasible(covariance: Matrix, lo: number[], hi: number[], budget: number): SolverOutput {
  const n = covariance.length;
  const w = projectAffineBox(scaleToSum(ones(n), budget), ones(n), budget, lo, hi);
  return { weights: w, objective: quadForm(covariance, w), iterations: 0, converged: false };
}

/** Validate a per-asset mean vector: correct length and all finite. */
function requireMeanVector(
  mean: ArrayLike<number>,
  n: number,
  functionName: string,
  field = 'mean',
): number[] {
  return snapshotFiniteVector(functionName, field, mean, n);
}

/** Largest eigenvalue of a symmetric matrix (for the projected-gradient step size). */
function maxEigenvalue(M: Matrix): number {
  return Math.max(...jacobiEigen(M).values, 1e-12);
}

/**
 * Condition number κ(Σ) = λ_max / λ_min above which `Σ⁻¹` — the closed form every unconstrained
 * optimizer here uses — amplifies estimation noise past the point where the weights mean anything.
 * At κ ≈ 1e10 a double has ~6 significant digits left in the solve, and two nearly-collinear assets
 * produce the classic million-times-leverage long/short pair that "converged".
 */
const MAX_COVARIANCE_CONDITION_NUMBER = 1e10;

/**
 * Conditioning check shared by every Σ⁻¹-based optimizer (minVariance, maxSharpe, meanVariance,
 * kelly, blackLitterman). A near-singular covariance is NOT an input error — `spdInverse` succeeds,
 * the arithmetic is finite, and the weights are the true solution of the stated problem. They are
 * simply not trustworthy: a 1e-10 eigenvalue turns a rounding-level difference in expected returns
 * into ±5,000,000× leverage. So the weights are still returned, `converged` drops to false, and a
 * `risk.ill_conditioned_covariance` warning names κ and the fix (shrinkage / fewer assets / more
 * history). Uses the same eigen machinery the projected-gradient step size already relies on.
 */
function conditioningWarning(covariance: Matrix, functionName: string): QuantWarning | undefined {
  let values: number[];
  try {
    values = jacobiEigen(covariance).values;
  } catch {
    // A covariance the eigensolver cannot factor is handled by the callers' own guards (cholesky
    // throws `linalg.not_positive_definite`); never let the diagnostic itself become the failure.
    return undefined;
  }
  let lambdaMax = -Infinity;
  let lambdaMin = Infinity;
  for (const v of values) {
    if (v > lambdaMax) lambdaMax = v;
    if (v < lambdaMin) lambdaMin = v;
  }
  if (!Number.isFinite(lambdaMax) || !Number.isFinite(lambdaMin) || lambdaMax <= 0)
    return undefined;
  const condition = lambdaMin > 0 ? lambdaMax / lambdaMin : Infinity;
  if (condition <= MAX_COVARIANCE_CONDITION_NUMBER) return undefined;
  return warning(
    ErrorCode.RiskIllConditionedCovariance,
    `${functionName}: the covariance matrix is ill-conditioned (condition number ${condition.toExponential(2)} > ${MAX_COVARIANCE_CONDITION_NUMBER.toExponential(0)}; smallest eigenvalue ${lambdaMin.toExponential(2)}) — Σ⁻¹ amplifies estimation noise into extreme offsetting weights, so the returned portfolio is reported with converged: false. Shrink the covariance (see \`shrunkCovariance\`), drop collinear assets, or use a longer sample.`,
    'warn',
    { conditionNumber: condition, smallestEigenvalue: lambdaMin, largestEigenvalue: lambdaMax },
  );
}

/**
 * Attach the conditioning verdict to a solver output: the weights survive untouched, the warning is
 * appended, and `converged` becomes false so no caller can treat an ill-conditioned solve as a
 * clean one.
 */
function withConditioning(
  result: SolverOutput,
  covariance: Matrix,
  functionName: string,
): SolverOutput {
  const w = conditioningWarning(covariance, functionName);
  if (w === undefined) return result;
  return {
    ...result,
    converged: false,
    reason: result.reason ?? 'ill_conditioned_covariance',
    warnings: [...(result.warnings ?? []), w],
  };
}

/**
 * Euclidean projection of `x` onto `{ w : aᵀw = c, lo ≤ w ≤ hi }` via bisection on the dual `τ`:
 * `w_i(τ) = clamp(x_i − τ·a_i, lo_i, hi_i)`; `aᵀw(τ)` is monotone non-increasing in `τ`.
 */
function projectAffineBox(
  x: number[],
  a: number[],
  c: number,
  lo: number[],
  hi: number[],
): number[] {
  const apply = (tau: number): number[] =>
    x.map((xi, i) => Math.min(hi[i]!, Math.max(lo[i]!, xi - tau * a[i]!)));
  const sumA = (w: number[]): number => dot(a, w);
  // bracket τ
  let loTau = -1;
  let hiTau = 1;
  let guard = 0;
  while (sumA(apply(loTau)) < c && guard++ < 200) loTau *= 2;
  guard = 0;
  while (sumA(apply(hiTau)) > c && guard++ < 200) hiTau *= 2;
  for (let it = 0; it < 200; it++) {
    const mid = 0.5 * (loTau + hiTau);
    const s = sumA(apply(mid));
    if (Math.abs(s - c) < 1e-13) return apply(mid);
    if (s > c) loTau = mid;
    else hiTau = mid;
  }
  return apply(0.5 * (loTau + hiTau));
}

/** Euclidean projection of `v` onto the L1 ball `{u : ‖u‖₁ ≤ r}` (Duchi et al. 2008). */
function projectL1Ball(v: number[], r: number): number[] {
  let l1 = 0;
  for (const x of v) l1 += Math.abs(x);
  if (l1 <= r) return v.slice();
  const u = v.map(Math.abs).sort((a, b) => b - a);
  let cumulativeSum = 0;
  let rho = 0;
  let theta = 0;
  for (let j = 0; j < u.length; j++) {
    cumulativeSum += u[j]!;
    const t = (cumulativeSum - r) / (j + 1);
    if (u[j]! - t > 0) {
      rho = j + 1;
      theta = t;
    }
  }
  void rho;
  return v.map((x) => Math.sign(x) * Math.max(0, Math.abs(x) - theta));
}

/** A convex set the feasible region is the intersection of, exposing its Euclidean projection. */
interface ConvexSet {
  project(w: number[]): number[];
}

function planeSet(a: number[], c: number): ConvexSet {
  const aa = dot(a, a);
  return { project: (w) => w.map((wi, i) => wi - ((dot(a, w) - c) / aa) * a[i]!) };
}
function halfSpaceLeqSet(a: number[], b: number): ConvexSet {
  const aa = dot(a, a);
  return {
    project: (w) => {
      const s = dot(a, w);
      return s <= b ? w.slice() : w.map((wi, i) => wi - ((s - b) / aa) * a[i]!);
    },
  };
}
function boxSet(lo: number[], hi: number[]): ConvexSet {
  return { project: (w) => w.map((wi, i) => Math.min(hi[i]!, Math.max(lo[i]!, wi))) };
}
function l1BallSet(prev: number[], r: number): ConvexSet {
  return {
    project: (w) => {
      const shifted = projectL1Ball(
        w.map((wi, i) => wi - prev[i]!),
        r,
      );
      return shifted.map((s, i) => s + prev[i]!);
    },
  };
}

/** Indicator of an extended (non box+budget) constraint that needs the general polytope projector. */
function hasExtendedConstraints(c: OptimizeConstraints): boolean {
  return Boolean(c.groups?.length || c.turnover);
}

/** Build the convex sets whose intersection is the feasible region (budget plane is always first). */
function buildConvexSets(
  n: number,
  lo: number[],
  hi: number[],
  budget: number,
  c: OptimizeConstraints,
): ConvexSet[] {
  const sets: ConvexSet[] = [planeSet(ones(n), budget), boxSet(lo, hi)];
  for (const g of c.groups ?? []) {
    const a = new Array<number>(n).fill(0);
    for (const m of g.members) a[m] = 1;
    if (g.max !== undefined && Number.isFinite(g.max)) sets.push(halfSpaceLeqSet(a, g.max));
    if (g.min !== undefined && Number.isFinite(g.min))
      sets.push(
        halfSpaceLeqSet(
          a.map((x) => -x),
          -g.min,
        ),
      );
  }
  if (c.turnover) sets.push(l1BallSet(c.turnover.previousWeights, c.turnover.max));
  return sets;
}

/**
 * Euclidean projection of `x` onto the intersection of `sets` via **Dykstra's algorithm** — cyclic
 * projection with per-set correction terms, which (unlike plain alternating projection) converges to
 * the true projection onto the intersection of the convex sets.
 */
function projectFeasible(
  x: number[],
  sets: ConvexSet[],
  maximumIterations = 500,
  tolerance = 1e-12,
): number[] {
  const n = x.length;
  let w = x.slice();
  const corr = sets.map(() => new Array<number>(n).fill(0));
  for (let it = 0; it < maximumIterations; it++) {
    let change = 0;
    for (let k = 0; k < sets.length; k++) {
      const y = w.map((wi, i) => wi - corr[k]![i]!);
      const p = sets[k]!.project(y);
      for (let i = 0; i < n; i++) {
        corr[k]![i] = p[i]! - y[i]!;
        change += (p[i]! - w[i]!) ** 2;
      }
      w = p;
    }
    if (Math.sqrt(change) < tolerance) break;
  }
  return w;
}

/** Per-asset transaction-cost rate vector and base weights, or null when unset. */
function txnCost(n: number, c: OptimizeConstraints): { rate: number[]; prev: number[] } | null {
  if (!c.transactionCosts) return null;
  const { perUnitTurnover, previousWeights } = c.transactionCosts;
  const rateVec =
    typeof perUnitTurnover === 'number'
      ? new Array<number>(n).fill(perUnitTurnover)
      : perUnitTurnover;
  return { rate: rateVec, prev: previousWeights };
}

/**
 * Generalized projected-(sub)gradient descent of a convex objective over the intersection of
 * `sets`, optionally including a non-smooth `Σ rate_i·|w_i − prev_i|` transaction-cost term. Used by
 * the constrained optimizers when sector/turnover/cost constraints make the affine-box projector
 * insufficient. `objective` is reported (lower is better); `grad` is the smooth-part gradient.
 */
function projectedGradientGeneral(input: {
  sets: ConvexSet[];
  budget: number;
  size: number;
  gradient: (weights: number[]) => number[];
  objective: (weights: number[]) => number;
  lipschitz: number;
  transactionCost: { rate: number[]; prev: number[] } | null;
  maxIterations: number;
  tolerance: number;
}): SolverOutput {
  const {
    sets,
    budget,
    size: n,
    gradient: grad,
    objective,
    lipschitz: L,
    transactionCost: cost,
    maxIterations: maximumIterations,
    tolerance,
  } = input;
  let w = projectFeasible(scaleToSum(ones(n), budget), sets);
  let iterations = 0;
  let converged = false;
  for (let it = 0; it < maximumIterations; it++) {
    iterations = it + 1;
    const g = grad(w);
    if (cost) for (let i = 0; i < n; i++) g[i]! += cost.rate[i]! * Math.sign(w[i]! - cost.prev[i]!);
    const step = w.map((wi, i) => wi - g[i]! / L);
    const wn = projectFeasible(step, sets);
    let difference = 0;
    for (let i = 0; i < n; i++) difference += (wn[i]! - w[i]!) ** 2;
    w = wn;
    if (Math.sqrt(difference) < tolerance) {
      converged = true;
      break;
    }
  }
  return { weights: w, objective: objective(w), iterations, converged };
}

/** Projected-gradient minimization of a convex quadratic with an affine-box feasible set. */
function projectedQp(input: {
  covariance: Matrix;
  linear: number[]; // objective = wᵀΣw·qWeight − linearᵀw form handled by caller's gradient
  gradient: (weights: number[]) => number[];
  affineCoefficients: number[];
  affineTarget: number;
  lowerBounds: number[];
  upperBounds: number[];
  lipschitz: number;
  maxIterations: number;
  tolerance: number;
}): SolverOutput {
  const {
    covariance,
    linear,
    gradient: grad,
    affineCoefficients: a,
    affineTarget: c,
    lowerBounds: lo,
    upperBounds: hi,
    lipschitz: L,
    maxIterations: maximumIterations,
    tolerance,
  } = input;
  const n = covariance.length;
  let w = projectAffineBox(scaleToSum(ones(n), c), a, c, lo, hi);
  let iterations = 0;
  let converged = false;
  for (let it = 0; it < maximumIterations; it++) {
    iterations = it + 1;
    const g = grad(w);
    const step = w.map((wi, i) => wi - g[i]! / L);
    const wn = projectAffineBox(step, a, c, lo, hi);
    let difference = 0;
    for (let i = 0; i < n; i++) difference += (wn[i]! - w[i]!) ** 2;
    w = wn;
    if (Math.sqrt(difference) < tolerance) {
      converged = true;
      break;
    }
  }
  void linear;
  return { weights: w, objective: quadForm(covariance, w), iterations, converged };
}

// ───────────────────────── minimum variance ─────────────────────────

/** Global minimum-variance portfolio. Objective = portfolio variance. */
function minVarianceSolve(covariance: Matrix, constraints: OptimizeConstraints = {}): SolverOutput {
  assertSquare(covariance, covariance.length, 'minVariance');
  validateConstraints(constraints, 'minVariance', covariance.length);
  const budget = constraints.budget ?? 1;
  if (!hasInequality(constraints)) {
    const inv = spdInverse(covariance);
    const z = matVec(inv, ones(covariance.length));
    const w = scaleToSum(z, budget);
    return { weights: w, objective: quadForm(covariance, w), iterations: 0, converged: true };
  }
  const { lo, hi } = resolveBounds(covariance.length, constraints);
  if (!boxBudgetFeasible(lo, hi, budget)) return infeasible(covariance, lo, hi, budget);
  const L = 2 * maxEigenvalue(covariance);
  const maximumIterations = constraints.maximumIterations ?? 5000;
  const tolerance = constraints.tolerance ?? 1e-11;
  const grad = (w: number[]): number[] => matVec(covariance, w).map((x) => 2 * x);
  const cost = txnCost(covariance.length, constraints);
  if (hasExtendedConstraints(constraints) || cost) {
    const sets = buildConvexSets(covariance.length, lo, hi, budget, constraints);
    const res = projectedGradientGeneral({
      sets,
      budget,
      size: covariance.length,
      gradient: grad,
      objective: (w) => quadForm(covariance, w),
      lipschitz: L,
      transactionCost: cost,
      maxIterations: maximumIterations,
      tolerance,
    });
    const viol = maxConstraintViolation(res.weights, budget, lo, hi, constraints);
    return { ...res, converged: res.converged && viol <= FEASIBILITY_TOL };
  }
  return projectedQp({
    covariance,
    linear: [],
    gradient: grad,
    affineCoefficients: ones(covariance.length),
    affineTarget: budget,
    lowerBounds: lo,
    upperBounds: hi,
    lipschitz: L,
    maxIterations: maximumIterations,
    tolerance,
  });
}

// ───────────────────────── maximum Sharpe (tangency) ─────────────────────────

export interface MaxSharpeOptions extends OptimizeConstraints {
  /**
   * Risk-free rate **in the same per-period units as `mean` and `covariance`** — a daily-return
   * problem takes a daily rate (0.04/252), not 0.04. Default 0.
   *
   * Named `riskFreeRatePerPeriod` (renamed from `riskFreeRate` pre-1.0) because every other
   * `riskFreeRate` in the library — `@insiderfinance/totalfinance/performance`'s sharpe/sortino/alpha, the backtest
   * report — is an ANNUAL rate that the callee de-annualizes. Passing 0.04 here on daily inputs
   * silently subtracted a 4%-per-DAY hurdle, turning every excess return negative and dropping
   * maxSharpe into its min-variance fallback. One spelling per unit: the compiler now catches it.
   */
  riskFreeRatePerPeriod?: number;
}

/** The documented {@link MaxSharpeOptions} keys. */
const MAX_SHARPE_OPTIONS_KEYS = [...OPTIMIZE_CONSTRAINTS_KEYS, 'riskFreeRatePerPeriod'] as const;

/** Maximum-Sharpe (tangency) portfolio. Objective = the Sharpe ratio at the solution. */
function maxSharpeSolve(
  mean: ArrayLike<number>,
  covariance: Matrix,
  options: MaxSharpeOptions = {},
): SolverOutput {
  const n = covariance.length;
  assertSquare(covariance, n, 'maxSharpe');
  validateConstraints(options, 'maxSharpe', n);
  const mu = requireMeanVector(mean, n, 'maxSharpe');
  ensureFiniteWhenPresent(options.riskFreeRatePerPeriod, 'riskFreeRatePerPeriod', 'maxSharpe');
  const rf = options.riskFreeRatePerPeriod ?? 0;
  ensureFinite(rf, 'riskFreeRatePerPeriod', 'maxSharpe');
  const excess = mu.map((m) => m - rf);
  const budget = options.budget ?? 1;
  const sharpe = (w: number[]): number => {
    const sd = Math.sqrt(Math.max(0, quadForm(covariance, w)));
    return sd > 0 ? (dot(excess, w) * budget) / sd : 0;
  };
  // When no tangency portfolio exists, return one finite, useful fallback and disclose the
  // substitution. Public optimizer envelopes are never allowed to carry NaN sentinels.
  const minVarianceFallback = (code: string, message: string, reason: string): SolverOutput => {
    const mv = minVarianceSolve(covariance, options);
    return {
      ...mv,
      objective: sharpe(mv.weights),
      converged: false,
      reason,
      method: 'min_variance_fallback',
      warnings: [
        ...(mv.warnings ?? []),
        warning(code, message, 'warn', { fallback: 'minVariance' }),
      ],
    };
  };
  if (!hasInequality(options)) {
    const z = matVec(spdInverse(covariance), excess);
    const s = z.reduce((a, b) => a + b, 0);
    // The tangency portfolio scales z to the budget. When `1ᵀΣ⁻¹(μ−rf) ≤ 0` the scaling divides by a
    // non-positive total and flips every weight into a NEGATIVE-Sharpe portfolio — that is infeasible,
    // not a solution. Report it honestly rather than silently returning a flipped or min-variance mix.
    if (s <= FEASIBILITY_TOL) {
      return minVarianceFallback(
        'risk.infeasible_tangency',
        'maxSharpe: the unconstrained tangency portfolio is infeasible (1ᵀΣ⁻¹(μ−rf) ≤ 0). Returning the minimum-variance portfolio instead; `objective` is its Sharpe ratio and diagnostics disclose the fallback.',
        'infeasible_tangency',
      );
    }
    const w = scaleToSum(z, budget);
    return { weights: w, objective: sharpe(w), iterations: 0, converged: true };
  }
  const { lo, hi } = resolveBounds(n, options);
  if (!boxBudgetFeasible(lo, hi, budget)) {
    const w = projectAffineBox(scaleToSum(ones(n), budget), ones(n), budget, lo, hi);
    return {
      weights: w,
      objective: sharpe(w),
      iterations: 0,
      converged: false,
      reason: 'infeasible_box',
      warnings: [
        warning(
          WarningCode.RiskInfeasibleConstraints,
          'maxSharpe: the box bounds cannot sum to the budget — no feasible portfolio exists; returning the best-effort projection with converged: false.',
          'warn',
          { budget },
        ),
      ],
    };
  }
  if (excess.every((e) => e <= 0)) {
    return minVarianceFallback(
      'risk.no_positive_excess',
      'maxSharpe: every excess return (μ − rf) is ≤ 0, so no positive-Sharpe portfolio exists — returning the minimum-variance portfolio instead; `objective` is its (non-positive) Sharpe ratio, not a tangency solution.',
      'no_positive_excess',
    );
  }

  // Box-constrained tangency is a fractional program: scale-invariance is broken by the bounds, so
  // the old "solve in excessᵀv=1 space then renormalize" trick can push a final weight past its
  // bound. Instead trace the *box-constrained* efficient frontier by sweeping the risk-aversion λ
  // through `meanVariance` (whose projected-gradient keeps every iterate inside the box and on the
  // budget plane) and keep the highest-Sharpe point — so the result is feasible by construction.
  // Forward only the defined constraints (exactOptionalPropertyTypes forbids explicit `undefined`).
  const mvBase: MeanVarianceOptions = {
    budget,
    ...(options.bounds !== undefined ? { bounds: options.bounds } : {}),
    ...(options.longOnly !== undefined ? { longOnly: options.longOnly } : {}),
    ...(options.groups !== undefined ? { groups: options.groups } : {}),
    ...(options.turnover !== undefined ? { turnover: options.turnover } : {}),
    ...(options.transactionCosts !== undefined
      ? { transactionCosts: options.transactionCosts }
      : {}),
    ...(options.maximumIterations !== undefined
      ? { maximumIterations: options.maximumIterations }
      : {}),
    ...(options.tolerance !== undefined ? { tolerance: options.tolerance } : {}),
  };
  const evalAt = (logLambda: number): { s: number; w: number[]; iters: number } => {
    const mv = meanVarianceSolve(mu, covariance, { ...mvBase, riskAversion: 10 ** logLambda });
    return {
      s: mv.converged ? sharpe(mv.weights) : -Infinity,
      w: mv.weights,
      iters: mv.iterations,
    };
  };

  let iterations = 0;
  let best: { s: number; w: number[] } | null = null;
  let bestLog = 0;
  for (let k = 0; k <= 64; k++) {
    const logLambda = -4 + (8 * k) / 64;
    const e = evalAt(logLambda);
    iterations += e.iters;
    if (e.s > (best?.s ?? -Infinity)) {
      best = { s: e.s, w: e.w };
      bestLog = logLambda;
    }
  }
  if (best === null) {
    return minVarianceFallback(
      'risk.frontier_sweep_failed',
      'maxSharpe: no point of the constrained efficient-frontier sweep converged — returning the minimum-variance portfolio instead; `objective` is its Sharpe ratio, not a tangency solution.',
      'frontier_sweep_failed',
    );
  }

  // Golden-section refinement on log₁₀(λ) around the best grid point for a sharper optimum.
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = bestLog - 8 / 64;
  let b = bestLog + 8 / 64;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let fc = evalAt(c);
  let fd = evalAt(d);
  iterations += fc.iters + fd.iters;
  for (let it = 0; it < 40 && b - a > 1e-6; it++) {
    if (fc.s > fd.s) {
      b = d;
      d = c;
      fd = fc;
      c = b - phi * (b - a);
      fc = evalAt(c);
      iterations += fc.iters;
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + phi * (b - a);
      fd = evalAt(d);
      iterations += fd.iters;
    }
  }
  const refined = fc.s > fd.s ? fc : fd;
  if (refined.s > best.s) best = { s: refined.s, w: refined.w };
  // The sweep only keeps feasible (mv.converged) points, but re-check so an infeasible problem can
  // never report success.
  const viol = maxConstraintViolation(best.w, budget, lo, hi, options);
  return { weights: best.w, objective: best.s, iterations, converged: viol <= FEASIBILITY_TOL };
}

// ───────────────────────── mean-variance utility ─────────────────────────

export interface MeanVarianceOptions extends OptimizeConstraints {
  /** Risk-aversion `λ` in `max μᵀw − (λ/2)·wᵀΣw`. Higher ⇒ more conservative. Default 1. */
  riskAversion?: number;
}

/** The documented {@link MeanVarianceOptions} keys. */
const MEAN_VARIANCE_OPTIONS_KEYS = [...OPTIMIZE_CONSTRAINTS_KEYS, 'riskAversion'] as const;

/** Mean-variance utility portfolio `max μᵀw − (λ/2)wᵀΣw`. Objective = the utility at the solution. */
function meanVarianceSolve(
  mean: ArrayLike<number>,
  covariance: Matrix,
  options: MeanVarianceOptions = {},
): SolverOutput {
  const n = covariance.length;
  assertSquare(covariance, n, 'meanVariance');
  validateConstraints(options, 'meanVariance', n);
  const mu = requireMeanVector(mean, n, 'meanVariance');
  ensureFiniteWhenPresent(options.riskAversion, 'riskAversion', 'optimize');
  const lambda = options.riskAversion ?? 1;
  if (!(lambda > 0 && Number.isFinite(lambda))) {
    throw new InputError(`meanVariance: riskAversion must be a finite number > 0, got ${lambda}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { riskAversion: lambda },
    });
  }
  const budget = options.budget ?? 1;
  const utility = (w: number[]): number => dot(mu, w) - 0.5 * lambda * quadForm(covariance, w);
  if (!hasInequality(options)) {
    // w = Σ⁻¹μ/λ + ((budget − 1ᵀΣ⁻¹μ/λ)/(1ᵀΣ⁻¹1))·Σ⁻¹1
    const inv = spdInverse(covariance);
    const im = matVec(inv, mu);
    const i1 = matVec(inv, ones(n));
    const a = im.map((x) => x / lambda);
    const sumA = a.reduce((s, b) => s + b, 0);
    const sum1 = i1.reduce((s, b) => s + b, 0);
    const gamma = (budget - sumA) / sum1;
    const w = a.map((ai, k) => ai + gamma * i1[k]!);
    return { weights: w, objective: utility(w), iterations: 0, converged: true };
  }
  const { lo, hi } = resolveBounds(n, options);
  if (!boxBudgetFeasible(lo, hi, budget)) {
    const w = projectAffineBox(scaleToSum(ones(n), budget), ones(n), budget, lo, hi);
    return { weights: w, objective: utility(w), iterations: 0, converged: false };
  }
  const cost = txnCost(n, options);
  if (hasExtendedConstraints(options) || cost) {
    // Minimize −utility (+ transaction costs) over the constraint polytope; report the utility.
    const Lg = lambda * maxEigenvalue(covariance);
    const sets = buildConvexSets(n, lo, hi, budget, options);
    const res = projectedGradientGeneral({
      sets,
      budget,
      size: n,
      gradient: (w) => matVec(covariance, w).map((x, i) => lambda * x - mu[i]!),
      objective: (w) => utility(w),
      lipschitz: Lg,
      transactionCost: cost,
      maxIterations: options.maximumIterations ?? 5000,
      tolerance: options.tolerance ?? 1e-11,
    });
    const viol = maxConstraintViolation(res.weights, budget, lo, hi, options);
    return { ...res, converged: res.converged && viol <= FEASIBILITY_TOL };
  }
  // projected-gradient ASCENT on the concave utility; grad = μ − λΣw.
  const L = lambda * maxEigenvalue(covariance);
  let w = projectAffineBox(scaleToSum(ones(n), budget), ones(n), budget, lo, hi);
  let iterations = 0;
  let converged = false;
  const maximumIterations = options.maximumIterations ?? 5000;
  const tolerance = options.tolerance ?? 1e-11;
  for (let it = 0; it < maximumIterations; it++) {
    iterations = it + 1;
    const cw = matVec(covariance, w); // hoisted: one mat-vec per iteration, not one per gradient component
    const g = mu.map((m, i) => m - lambda * cw[i]!);
    const step = w.map((wi, i) => wi + g[i]! / L);
    const wn = projectAffineBox(step, ones(n), budget, lo, hi);
    let difference = 0;
    for (let i = 0; i < n; i++) difference += (wn[i]! - w[i]!) ** 2;
    w = wn;
    if (Math.sqrt(difference) < tolerance) {
      converged = true;
      break;
    }
  }
  return { weights: w, objective: utility(w), iterations, converged };
}

// ───────────────────────── risk parity (equal risk contribution) ─────────────────────────

/**
 * Risk-parity (equal-risk-contribution) portfolio: long-only weights where every asset contributes
 * the same share of portfolio volatility. Objective = the (equal) risk contribution. Solved with the
 * standard cyclical fixed-point `w_i ← (1/n) / (Σw)_i`, renormalized each pass.
 */
function riskParitySolve(
  covariance: Matrix,
  options: { budget?: number; maximumIterations?: number; tolerance?: number } = {},
): SolverOutput {
  const n = covariance.length;
  assertSquare(covariance, n, 'riskParity');
  validateConstraints(options, 'riskParity');
  const budget = options.budget ?? 1;
  const maximumIterations = options.maximumIterations ?? 10000;
  const tolerance = options.tolerance ?? 1e-12;
  // Cyclical coordinate descent on f(w) = ½wᵀΣw − Σ b_i·ln(w_i) (Griveau-Billion/Richard/Roncalli):
  // each coordinate solves cov_ii·w_i² + β_i·w_i − b_i = 0 ⇒ w_i = (−β + √(β²+4·cov_ii·b_i))/(2cov_ii).
  const b = 1 / n;
  let w = ones(n).map((x) => x / Math.sqrt(n));
  let iterations = 0;
  let converged = false;
  for (let it = 0; it < maximumIterations; it++) {
    iterations = it + 1;
    let difference = 0;
    for (let i = 0; i < n; i++) {
      let beta = 0;
      for (let j = 0; j < n; j++) if (j !== i) beta += covariance[i]![j]! * w[j]!;
      const a = covariance[i]![i]!;
      const wi = a > 0 ? (-beta + Math.sqrt(beta * beta + 4 * a * b)) / (2 * a) : w[i]!;
      difference += (wi - w[i]!) ** 2;
      w[i] = wi;
    }
    if (Math.sqrt(difference) < tolerance) {
      converged = true;
      break;
    }
  }
  w = scaleToSum(w, budget);
  const sigma = Math.sqrt(Math.max(0, quadForm(covariance, w)));
  return { weights: w, objective: sigma / n, iterations, converged };
}

// ───────────────────────── Hierarchical Risk Parity (López de Prado) ─────────────────────────

function covToCorr(covariance: Matrix): Matrix {
  const d = covariance.map((row, i) => (row[i]! > 0 ? 1 / Math.sqrt(row[i]!) : 0));
  return covariance.map((row, i) => row.map((c, j) => c * d[i]! * d[j]!));
}

/** Inverse-variance allocation over a subset of asset indices (weights sum to 1). */
function ivp(covariance: Matrix, idx: number[]): number[] {
  const inv = idx.map((i) => (covariance[i]![i]! > 0 ? 1 / covariance[i]![i]! : 0));
  const s = inv.reduce((a, b) => a + b, 0);
  return inv.map((x) => (s > 0 ? x / s : 1 / idx.length));
}

/** Variance of the inverse-variance portfolio over a cluster (for recursive bisection). */
function clusterVar(covariance: Matrix, idx: number[]): number {
  const w = ivp(covariance, idx);
  let v = 0;
  for (let a = 0; a < idx.length; a++)
    for (let b = 0; b < idx.length; b++) v += w[a]! * covariance[idx[a]!]![idx[b]!]! * w[b]!;
  return v;
}

/** Average-linkage agglomerative clustering on the correlation-distance matrix → leaf order. */
function quasiDiagonalOrder(corr: Matrix): number[] {
  const n = corr.length;
  const dist = corr.map((row, i) => row.map((c, j) => (i === j ? 0 : Math.sqrt(0.5 * (1 - c)))));
  // each cluster is a list of leaf indices; merge nearest until one remains
  let clusters: number[][] = Array.from({ length: n }, (_, i) => [i]);
  const clusterDist = (A: number[], B: number[]): number => {
    let s = 0;
    for (const a of A) for (const b of B) s += dist[a]![b]!;
    return s / (A.length * B.length); // average linkage
  };
  while (clusters.length > 1) {
    let best = Infinity;
    let bi = 0;
    let bj = 1;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = clusterDist(clusters[i]!, clusters[j]!);
        if (d < best) {
          best = d;
          bi = i;
          bj = j;
        }
      }
    }
    const merged = [...clusters[bi]!, ...clusters[bj]!];
    clusters = clusters.filter((_, k) => k !== bi && k !== bj);
    clusters.push(merged);
  }
  return clusters[0]!;
}

/**
 * Hierarchical Risk Parity (López de Prado 2016): cluster assets by correlation distance, order them
 * (quasi-diagonalization), then recursively split the ordered list, allocating between halves by
 * inverse cluster variance. Long-only, fully diversified, no matrix inversion. Objective = variance.
 */
function hrpSolve(covariance: Matrix, options: { budget?: number } = {}): SolverOutput {
  requireArgumentArray('hrp', 'covariance', covariance);
  if (covariance.length === 0 || !Array.isArray(covariance[0])) {
    throw new InputError('hrp: covariance must be a non-empty square covariance matrix.', {
      code: ErrorCode.InputOutOfRange,
      context: { rows: covariance.length },
    });
  }
  const n = covariance.length;
  assertSquare(covariance, n, 'hrp');
  validateConstraints(options, 'hrp');
  const budget = options.budget ?? 1;
  const order = quasiDiagonalOrder(covToCorr(covariance));
  const w = new Array<number>(n).fill(1);
  const recurse = (items: number[]): void => {
    if (items.length <= 1) return;
    const mid = Math.floor(items.length / 2);
    const left = items.slice(0, mid);
    const right = items.slice(mid);
    const vL = clusterVar(covariance, left);
    const vR = clusterVar(covariance, right);
    const alpha = 1 - vL / (vL + vR); // weight to the left (lower-variance gets more)
    for (const i of left) w[i]! *= alpha;
    for (const i of right) w[i]! *= 1 - alpha;
    recurse(left);
    recurse(right);
  };
  recurse(order);
  const weights = scaleToSum(w, budget);
  return { weights, objective: quadForm(covariance, weights), iterations: 1, converged: true };
}

// ───────────────────────── Kelly ─────────────────────────

export interface KellyOptions extends OptimizeConstraints {
  /** Fraction of full Kelly (e.g. 0.5 for half-Kelly). Must be > 0. Default 1. */
  fraction?: number;
  /**
   * Normalize the Kelly weights to the `budget` (fully invested). Default false (leverage implied).
   * When the raw Kelly weights sum to ≤ 0 (a net-short growth-optimal book), dividing by that total
   * would flip every position's sign — instead the UNnormalized weights are returned with
   * `converged: false` and a `risk.kelly_negative_sum` warning (design law #4: disclose, don't flip).
   * With `constraints`, this flag is a no-op: the constrained solve already pins Σw to the budget.
   */
  normalize?: boolean;
}

/** The documented {@link KellyOptions} keys. */
const KELLY_OPTIONS_KEYS = [...OPTIMIZE_CONSTRAINTS_KEYS, 'fraction', 'normalize'] as const;

/**
 * Kelly-optimal (growth-maximizing) weights. Unconstrained this is `w = fraction · Σ⁻¹μ` — the
 * maximizer of the log-growth quadratic approximation `μᵀw − ½·wᵀΣw` — with the magnitude left as-is
 * (the implied leverage) unless `normalize` scales it to the budget. Objective = `μᵀw`.
 *
 * **Under inequality constraints** (box / group / turnover) the growth-optimal portfolio is NOT the
 * unconstrained point projected onto the feasible set — that lands feasible but off the optimum.
 * Constrained Kelly is the constrained maximizer of the same log-growth quadratic, i.e. a
 * mean-variance solve at risk-aversion `1/fraction` (fractional Kelly f ⇔ λ = 1/f) over the identical
 * constraint set; that is what this returns.
 */
function kellySolve(
  mean: ArrayLike<number>,
  covariance: Matrix,
  options: KellyOptions = {},
): SolverOutput {
  const n = covariance.length;
  assertSquare(covariance, n, 'kelly');
  validateConstraints(options, 'kelly', n);
  const mu = requireMeanVector(mean, n, 'kelly');
  ensureFiniteWhenPresent(options.fraction, 'fraction', 'kelly');
  if (options.normalize !== undefined && typeof options.normalize !== 'boolean') {
    throw new InputError(
      `kelly: normalize must be a boolean when provided. Received ${options.normalize === null ? 'null' : typeof options.normalize}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'normalize' } },
    );
  }
  const fraction = options.fraction ?? 1;
  ensureFinite(fraction, 'fraction', 'kelly');
  // A non-positive fraction has no Kelly meaning in either branch: fractional Kelly f scales the
  // growth-optimal position (constrained: solves a risk-aversion 1/f quadratic), so f ≤ 0 is an error.
  if (!(fraction > 0)) {
    throw new InputError(
      `kelly: fraction must be positive (fractional Kelly f scales the growth-optimal position; constrained Kelly solves a risk-aversion 1/fraction quadratic); got ${fraction}.`,
      { code: ErrorCode.InputOutOfRange, context: { fraction } },
    );
  }
  if (hasInequality(options)) {
    // Re-solve the constrained log-growth quadratic rather than Euclidean-projecting the
    // unconstrained growth-optimal weights (design law #4: give the real constrained optimum).
    const mv = meanVarianceSolve(mu, covariance, { ...options, riskAversion: 1 / fraction });
    return { ...mv, objective: dot(mu, mv.weights) };
  }
  let w = matVec(spdInverse(covariance), mu).map((x) => x * fraction);
  if (options.normalize) {
    const budget = options.budget ?? 1;
    const total = w.reduce((a, b) => a + b, 0);
    // Scaling by a non-positive total would FLIP every position's sign (a net-short growth-optimal
    // book turned long). Mirror the maxSharpe infeasible-tangency precedent: disclose and refuse to
    // fabricate — return the unnormalized weights with converged:false and a structured warning.
    if (total <= 0) {
      return {
        weights: w,
        objective: dot(mu, w),
        iterations: 0,
        converged: false,
        reason: 'non_positive_kelly_sum',
        warnings: [
          warning(
            WarningCode.RiskKellyNegativeSum,
            `kelly: the raw Kelly weights sum to ${total} ≤ 0 — normalizing to a positive budget would flip every position's sign. Returning the UNnormalized weights; treat the book as net short (or drop normalize).`,
            'warn',
            { total, budget },
          ),
        ],
      };
    }
    w = scaleToSum(w, budget);
  }
  return { weights: w, objective: dot(mu, w), iterations: 0, converged: true };
}

// ───────────────────────── Black-Litterman ─────────────────────────

/** An investor view for {@link blackLitterman}. */
export interface BlackLittermanView {
  /** Asset pick weights (length n): e.g. `[1, -1, 0]` = "asset 0 outperforms asset 1 by `view`". */
  pick: number[];
  /** The view's expected (per-period) return Q for the pick portfolio. */
  view: number;
  /** View uncertainty (variance Ω_jj). Omit for the He–Litterman default `τ·pᵀΣp`. */
  confidence?: number;
}

export interface BlackLittermanOptions {
  /** Asset return covariance Σ (n×n). */
  covariance: Matrix;
  /** Prior (equilibrium) expected returns π. Provide this, or `marketWeights` to imply it. */
  priorMean?: ArrayLike<number>;
  /** Market-cap weights to reverse-engineer the prior `π = δ·Σ·w_mkt`. */
  marketWeights?: ArrayLike<number>;
  /** Risk-aversion δ for the implied prior and the posterior mean-variance weights. Default 2.5. */
  riskAversion?: number;
  /** Investor views (at least one). */
  views: BlackLittermanView[];
  /** Scalar τ scaling the prior uncertainty of the mean (default 0.05). */
  tau?: number;
  /** Constraints applied to the posterior mean-variance weights. */
  constraints?: OptimizeConstraints;
}

/**
 * The Black-Litterman result (dx §2.4): the core `Computed` envelope, like the other optimizers.
 * `value` carries the prior/posterior returns and the posterior-optimal weights; `assumptions` echo
 * the (possibly defaulted) `tau` and `riskAversion` plus the number of views blended; `diagnostics`
 * carry the posterior mean-variance solver's `converged`/`iterations` and all warnings.
 */
export type BlackLittermanResult = Computed<
  {
    /** The supplied or market-implied equilibrium prior π. */
    priorMean: number[];
    /** Posterior (views-blended) expected returns. */
    posteriorMean: number[];
    /** Posterior return covariance `Σ + M`, where `M` is the posterior covariance of the mean. */
    posteriorCovariance: number[][];
    /** Mean-variance-optimal weights under the posterior. */
    weights: number[];
  },
  { tau: number; riskAversion: number; views: number }
>;

/**
 * Black-Litterman (1992): blend a market-equilibrium prior on expected returns with subjective views
 * to get a posterior `μ_BL` and covariance, then mean-variance-optimize. The prior is either supplied
 * (`priorMean`) or reverse-engineered from market weights (`π = δ·Σ·w_mkt`); each view `j` carries an
 * uncertainty `Ω_jj` (default the He–Litterman `τ·pᵀΣp`). Posterior:
 *   `M = [(τΣ)⁻¹ + PᵀΩ⁻¹P]⁻¹`,  `μ_BL = M·[(τΣ)⁻¹π + PᵀΩ⁻¹Q]`,  `Σ_post = Σ + M`.
 *
 * Returns the standard `Computed` envelope (dx §2.4): the defaulted `tau: 0.05` / `riskAversion: 2.5`
 * are echoed in `assumptions` (never silently applied), and the posterior solve's convergence lives
 * in `diagnostics.converged` with an `optimize.not_converged` warning when it fails.
 */
export function blackLitterman(options: BlackLittermanOptions): BlackLittermanResult {
  // Law 12: a misspelled knob (`marketWieghts` silently dropping the prior) must throw, never no-op.
  requireClosedDataObject('blackLitterman', 'options', options, [
    'covariance',
    'priorMean',
    'marketWeights',
    'riskAversion',
    'views',
    'tau',
    'constraints',
  ]);
  requireArgumentArray(
    'blackLitterman',
    'options.covariance',
    (options as { covariance?: unknown }).covariance as never,
  );
  const functionName = 'blackLitterman';
  const covariance = options.covariance;
  const n = covariance.length;
  assertSquare(covariance, n, functionName);
  ensureFiniteWhenPresent(options.riskAversion, 'riskAversion', 'blackLitterman');
  const delta = options.riskAversion ?? 2.5;
  ensureFinite(delta, 'riskAversion', functionName);
  ensureFiniteWhenPresent(options.tau, 'tau', 'blackLitterman');
  if (
    options.constraints !== undefined &&
    (options.constraints === null || typeof options.constraints !== 'object')
  ) {
    throw new InputError(
      `blackLitterman: constraints must be an object when provided. Received ${options.constraints === null ? 'null' : typeof options.constraints}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'constraints' } },
    );
  }
  if (options.constraints !== undefined) {
    requireClosedDataObject(
      functionName,
      'options.constraints',
      options.constraints,
      OPTIMIZE_CONSTRAINTS_KEYS,
    );
    validateConstraints(options.constraints, functionName, n);
  }
  const tau = options.tau ?? 0.05;
  if (!(tau > 0 && Number.isFinite(tau))) {
    throw new InputError(`${functionName}: tau must be a finite number > 0, got ${tau}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { tau },
    });
  }
  if (!Array.isArray(options.views) || options.views.length === 0) {
    throw new InputError(`${functionName}: at least one view is required.`, {
      code: ErrorCode.InputOutOfRange,
      context: { views: options.views?.length ?? 0 },
    });
  }

  const suppliedPrior =
    options.priorMean === undefined
      ? undefined
      : requireMeanVector(options.priorMean, n, functionName, 'priorMean');
  const suppliedMarketWeights =
    options.marketWeights === undefined
      ? undefined
      : requireMeanVector(options.marketWeights, n, functionName, 'marketWeights');
  let pi: number[];
  if (suppliedPrior !== undefined) {
    pi = suppliedPrior;
  } else if (suppliedMarketWeights !== undefined) {
    const wm = suppliedMarketWeights;
    pi = matVec(covariance, wm).map((x) => delta * x);
  } else {
    throw new InputError(
      `${functionName}: provide priorMean or marketWeights to set the equilibrium prior.`,
      {
        code: ErrorCode.InputMissingField,
        context: {},
      },
    );
  }

  const sigmaInv = spdInverse(covariance);
  const tauSigmaInv = sigmaInv.map((row) => row.map((x) => x / tau));
  const A: number[][] = tauSigmaInv.map((row) => row.slice());
  const rhs = matVec(tauSigmaInv, pi);
  for (const v of options.views) {
    if (v.pick.length !== n) {
      throw new InputError(`${functionName}: view pick length (${v.pick.length}) must be ${n}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { got: v.pick.length, expected: n },
      });
    }
    const p = v.pick;
    const omega = v.confidence ?? tau * dot(p, matVec(covariance, p));
    if (!(omega > 0 && Number.isFinite(omega))) {
      throw new InputError(
        `${functionName}: view confidence must be a finite number > 0, got ${omega}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { omega },
        },
      );
    }
    const inv = 1 / omega;
    for (let i = 0; i < n; i++) {
      rhs[i]! += inv * v.view * p[i]!;
      for (let j = 0; j < n; j++) A[i]![j]! += inv * p[i]! * p[j]!;
    }
  }

  const M = spdInverse(A);
  const posteriorMean = matVec(M, rhs);
  const posteriorCovariance = covariance.map((row, i) => row.map((c, j) => c + M[i]![j]!));
  const mv = meanVarianceSolve(posteriorMean, posteriorCovariance, {
    riskAversion: delta,
    ...(options.constraints ?? {}),
  });
  // Reuse the shared envelope plumbing for the diagnostics (converged/iterations plus the
  // `optimize.not_converged` warning when the posterior solve fails) — one envelope, everywhere.
  // The prior Σ is inverted twice here (τΣ and the posterior precision), so it goes through the
  // same conditioning gate as the other Σ⁻¹ optimizers.
  const { diagnostics } = envelope(
    functionName,
    options.constraints?.budget ?? 1,
    withConditioning(mv, covariance, functionName),
  );
  return {
    value: { priorMean: pi, posteriorMean, posteriorCovariance, weights: mv.weights },
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      tau,
      riskAversion: delta,
      views: options.views.length,
    },
    diagnostics,
  };
}

// ───────────────────────── CVaR optimization (Rockafellar–Uryasev) ─────────────────────────

export interface CVaROptimizeOptions extends OptimizeConstraints {
  /** Tail confidence α: optimize the mean of the worst `(1 − α)` fraction of losses. Default 0.95. */
  alpha?: number;
  /** Optional minimum mean return `μᵀw ≥ minReturn` (μ = per-asset scenario means). */
  minReturn?: number;
  /** Projected-subgradient iteration cap. Default 4000. */
  maximumIterations?: number;
  /**
   * Initial subgradient step size (decays as `step/√t`). Defaults to `1/‖g₀‖` — the step that moves
   * the FIRST iterate a distance of about 1 in weight space, which is the scale weights live on.
   * A fixed default (this used to be `1`) is unit-dependent: on decimal daily returns ‖g‖ ≈ 0.01,
   * so every step moved ~1e-2·(1/√t) and the run plateaued a long way from the optimum while
   * reporting `converged: true`. Pass an explicit `step` only to override that scaling.
   */
  step?: number;
  /**
   * Relative-improvement tolerance for convergence: the run is `converged` only once the best CVaR
   * improves by less than this over the final 25 iterations. Default `1e-6`.
   */
  tolerance?: number;
}

/** The documented {@link CVaROptimizeOptions} keys. */
const CVAR_OPTIMIZE_OPTIONS_KEYS = [
  ...OPTIMIZE_CONSTRAINTS_KEYS,
  'alpha',
  'minReturn',
  'step',
] as const;

/** CVaR is a synchronous O(scenarios × assets × iterations) solve; cap width before allocation. */
const MAX_CVAR_ASSETS = 10_000;

/** CVaR-optimizer result: the standard envelope whose `value` also carries the optimized tail. */
export type CVaROptimizeResult = Computed<
  {
    weights: number[];
    objective: number;
    /** The optimized CVaR — mean loss over the worst `(1 − α)` tail (a positive magnitude). */
    conditionalValueAtRisk: number;
    /** The VaR threshold (loss quantile at α) at the solution. */
    valueAtRisk: number;
  },
  { objective: string; budget: number; confidence: number }
>;

/** Empirical CVaR/VaR of portfolio `w` over a scenario loss distribution, plus the tail index set. */
function cvarOf(
  scenarios: number[][],
  w: number[],
  alpha: number,
): { conditionalValueAtRisk: number; valueAtRisk: number; tail: number[] } {
  const S = scenarios.length;
  const losses = scenarios.map((row) => -dot(row, w));
  const order = losses.map((_, i) => i).sort((a, b) => losses[b]! - losses[a]!); // descending loss
  const tailCount = Math.max(1, Math.ceil((1 - alpha) * S));
  const tail = order.slice(0, tailCount);
  let sum = 0;
  for (const s of tail) sum += losses[s]!;
  return {
    conditionalValueAtRisk: sum / tailCount,
    valueAtRisk: losses[order[tailCount - 1]!]!,
    tail,
  };
}

/**
 * Subgradient of the empirical CVaR at `w`: minus the per-asset mean return over the tail
 * scenarios, plus the (non-smooth) linear transaction-cost term. One implementation, shared by the
 * descent loop and the default step-size scaling — so the step can never be calibrated against a
 * different gradient than the one that is taken.
 */
function cvarSubgradient(
  scenarios: number[][],
  w: number[],
  alpha: number,
  cost: { rate: number[]; prev: number[] } | null,
  n: number,
): number[] {
  const { tail } = cvarOf(scenarios, w, alpha);
  const g = new Array<number>(n).fill(0);
  for (const s of tail) for (let i = 0; i < n; i++) g[i]! -= scenarios[s]![i]! / tail.length;
  if (cost) for (let i = 0; i < n; i++) g[i]! += cost.rate[i]! * Math.sign(w[i]! - cost.prev[i]!);
  return g;
}

/**
 * Default initial subgradient step `1/‖g₀‖₂`: the first iterate then moves ~1 unit in weight space
 * regardless of whether the scenarios are decimals (0.01) or percent (1.0). Falls back to 1 on a
 * zero gradient (a flat scenario set — every weight is already optimal).
 */
function initialSubgradientStep(
  scenarios: number[][],
  w: number[],
  alpha: number,
  cost: { rate: number[]; prev: number[] } | null,
  n: number,
): number {
  const g = cvarSubgradient(scenarios, w, alpha, cost, n);
  let norm = 0;
  for (const gi of g) norm += gi * gi;
  norm = Math.sqrt(norm);
  return norm > 0 ? 1 / norm : 1;
}

/**
 * Minimize portfolio Conditional Value-at-Risk (expected shortfall) over a scenario set
 * (Rockafellar–Uryasev). CVaR(w) — the mean of the worst `(1 − α)` fraction of scenario losses — is
 * convex and piecewise-linear in `w`; this minimizes it by **projected subgradient** descent over the
 * constraint polytope (budget, box, sector/turnover, and an optional `minReturn` floor), tracking the
 * best feasible iterate. `scenarios[s][i]` is asset `i`'s return in scenario `s`.
 */
function cvarOptimizeSolve(
  scenarios: number[][],
  options: CVaROptimizeOptions = {},
): SolverOutput & { conditionalValueAtRisk: number; valueAtRisk: number } {
  const functionName = 'conditionalValueAtRiskOptimize';
  const S = scenarios.length;
  if (S < 2) {
    throw new InputError(`${functionName}: need ≥ 2 scenarios, got ${S}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { scenarios: S },
    });
  }
  const n = scenarios[0]!.length;
  for (let s = 0; s < S; s++) {
    const row = scenarios[s]!;
    if (row.length !== n) {
      throw new InputError(`${functionName}: every scenario row must list ${n} asset returns.`, {
        code: ErrorCode.InputOutOfRange,
        context: { expected: n, got: row.length },
      });
    }
    for (let i = 0; i < n; i++) {
      const value = row[i];
      if (!Number.isFinite(value)) {
        const received = describeInputValue(value);
        throw new InputError(
          `${functionName}: scenarios[${s}][${i}] must be finite, got ${received}.`,
          {
            code: ErrorCode.InputNotFinite,
            context: { scenario: s, asset: i, received },
          },
        );
      }
    }
  }
  validateConstraints(options, functionName, n);
  ensureFiniteWhenPresent(options.alpha, 'alpha', 'conditionalValueAtRiskOptimize');
  ensureFiniteWhenPresent(options.step, 'step', 'conditionalValueAtRiskOptimize');
  const alpha = options.alpha ?? 0.95;
  if (!(alpha > 0 && alpha < 1)) {
    throw new InputError(`${functionName}: alpha must be in (0, 1), got ${alpha}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { alpha },
    });
  }
  if (options.minReturn !== undefined && !Number.isFinite(options.minReturn)) {
    throw new InputError(`${functionName}: minReturn must be finite, got ${options.minReturn}.`, {
      code: ErrorCode.InputNotFinite,
      context: { minReturn: options.minReturn },
    });
  }
  if (options.step !== undefined && !(options.step > 0 && Number.isFinite(options.step))) {
    throw new InputError(
      `${functionName}: step must be a finite number > 0, got ${options.step}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { step: options.step },
      },
    );
  }
  const budget = options.budget ?? 1;

  const mu = new Array<number>(n).fill(0);
  for (const row of scenarios) for (let i = 0; i < n; i++) mu[i]! += row[i]! / S;

  const { lo, hi } = resolveBounds(n, options);
  if (!boxBudgetFeasible(lo, hi, budget)) {
    const w = projectAffineBox(scaleToSum(ones(n), budget), ones(n), budget, lo, hi);
    const m = cvarOf(scenarios, w, alpha);
    return {
      weights: w,
      objective: m.conditionalValueAtRisk,
      conditionalValueAtRisk: m.conditionalValueAtRisk,
      valueAtRisk: m.valueAtRisk,
      iterations: 0,
      converged: false,
    };
  }

  const sets = buildConvexSets(n, lo, hi, budget, options);
  if (options.minReturn !== undefined) {
    sets.push(
      halfSpaceLeqSet(
        mu.map((x) => -x),
        -options.minReturn,
      ),
    );
  }
  const cost = txnCost(n, options);
  const maximumIterations = options.maximumIterations ?? 4000;
  const relativeImprovementTolerance = options.tolerance ?? 1e-6;
  const PLATEAU_WINDOW = 25;

  let w = projectFeasible(scaleToSum(ones(n), budget), sets);
  // Scale the default step to the SUBGRADIENT, not to the number 1. The CVaR subgradient is a mean
  // of scenario returns, so on decimal daily data it is ~1e-2 and a step of 1 walks 1e-2 per
  // iteration — the descent flattens (and the plateau test fires) long before it reaches the
  // optimum. `1/‖g₀‖` makes the first move O(1) in weight space in ANY unit; the honesty machinery
  // (plateau vs max_iterations vs infeasible) is untouched.
  const step0 = options.step ?? initialSubgradientStep(scenarios, w, alpha, cost, n);
  let best = {
    w: w.slice(),
    conditionalValueAtRisk: cvarOf(scenarios, w, alpha).conditionalValueAtRisk,
  };
  let iterations = 0;
  // Best-objective history, so we can tell "the descent flattened out" (converged) from "we merely
  // ran out of iterations while still improving" (max_iterations) — the old code always claimed the
  // former (design law #4).
  const bestHist: number[] = [best.conditionalValueAtRisk];
  let plateaued = false;
  for (let it = 0; it < maximumIterations; it++) {
    iterations = it + 1;
    const g = cvarSubgradient(scenarios, w, alpha, cost, n);
    const eta = step0 / Math.sqrt(it + 1);
    w = projectFeasible(
      w.map((wi, i) => wi - eta * g[i]!),
      sets,
    );
    const cv = cvarOf(scenarios, w, alpha).conditionalValueAtRisk;
    if (cv < best.conditionalValueAtRisk) best = { w: w.slice(), conditionalValueAtRisk: cv };
    bestHist.push(best.conditionalValueAtRisk);
    if (bestHist.length > PLATEAU_WINDOW) {
      const prior = bestHist[bestHist.length - 1 - PLATEAU_WINDOW]!;
      const rel =
        Math.abs(best.conditionalValueAtRisk - prior) /
        (Math.abs(best.conditionalValueAtRisk) + 1e-12);
      if (rel < relativeImprovementTolerance) {
        plateaued = true;
        break; // stop early once the best objective has effectively stopped improving
      }
    }
  }
  const final = cvarOf(scenarios, best.w, alpha);
  // Only claim success if the best iterate is actually feasible (budget/box/groups/turnover and the
  // optional return floor) — an empty feasible region (e.g. an impossible minReturn) must not converge.
  const viol = maxConstraintViolation(
    best.w,
    budget,
    lo,
    hi,
    options,
    options.minReturn !== undefined ? { mu, minReturn: options.minReturn } : undefined,
  );
  const feasible = viol <= FEASIBILITY_TOL && Number.isFinite(final.conditionalValueAtRisk);
  const converged = feasible && plateaued;
  return {
    weights: best.w,
    objective: final.conditionalValueAtRisk,
    conditionalValueAtRisk: final.conditionalValueAtRisk,
    valueAtRisk: final.valueAtRisk,
    iterations,
    converged,
    // Distinguish "hit the iteration cap still improving" from an infeasible region.
    ...(converged ? {} : { reason: feasible ? 'max_iterations' : 'infeasible_region' }),
  };
}

// ───────────────────────── public facades (dx §2.4: one envelope) ─────────────────────────

/** Global minimum-variance portfolio. `value.objective` is the portfolio variance `wᵀΣw`. */
export function minVariance(
  covariance: Matrix,
  constraints: OptimizeConstraints = {},
): OptimizeResult {
  requireArgumentArray('minVariance', 'covariance', covariance);
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  requireClosedDataObject('minVariance', 'constraints', constraints, OPTIMIZE_CONSTRAINTS_KEYS);
  return envelope(
    'minVariance',
    constraints.budget ?? 1,
    withConditioning(minVarianceSolve(covariance, constraints), covariance, 'minVariance'),
  );
}

/** Tangency (max-Sharpe) portfolio. `value.objective` is the Sharpe ratio at the solution. */
export interface MaxSharpeInput {
  /** Dense stored-data ArrayLike; values are snapshotted without coercion. */
  mean: ArrayLike<number>;
  covariance: Matrix;
  options?: MaxSharpeOptions;
}

export function maxSharpe(input: MaxSharpeInput): OptimizeResult {
  requireClosedDataObject('maxSharpe', 'input', input, ['mean', 'covariance', 'options']);
  const { mean, covariance, options: options = {} } = input;
  requireArgumentArray('maxSharpe', 'covariance', covariance);
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  requireClosedDataObject('maxSharpe', 'options', options, MAX_SHARPE_OPTIONS_KEYS);
  return envelope(
    'maxSharpe',
    options.budget ?? 1,
    withConditioning(maxSharpeSolve(mean, covariance, options), covariance, 'maxSharpe'),
  );
}

/** Mean-variance utility portfolio (`μᵀw − λ/2·wᵀΣw`). `value.objective` is the utility. */
export interface MeanVarianceInput {
  /** Dense stored-data ArrayLike; values are snapshotted without coercion. */
  mean: ArrayLike<number>;
  covariance: Matrix;
  options?: MeanVarianceOptions;
}

export function meanVariance(input: MeanVarianceInput): OptimizeResult {
  requireClosedDataObject('meanVariance', 'input', input, ['mean', 'covariance', 'options']);
  const { mean, covariance, options: options = {} } = input;
  requireArgumentArray('meanVariance', 'covariance', covariance);
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  requireClosedDataObject('meanVariance', 'options', options, MEAN_VARIANCE_OPTIONS_KEYS);
  return envelope(
    'meanVariance',
    options.budget ?? 1,
    withConditioning(meanVarianceSolve(mean, covariance, options), covariance, 'meanVariance'),
  );
}

/** The documented `riskParity` option keys. */
const RISK_PARITY_OPTIONS_KEYS = ['budget', 'maximumIterations', 'tolerance'] as const;

/** Equal-risk-contribution (risk parity) portfolio. */
export function riskParity(
  covariance: Matrix,
  options: { budget?: number; maximumIterations?: number; tolerance?: number } = {},
): OptimizeResult {
  requireArgumentArray('riskParity', 'covariance', covariance);
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  requireClosedDataObject('riskParity', 'options', options, RISK_PARITY_OPTIONS_KEYS);
  return envelope('riskParity', options.budget ?? 1, riskParitySolve(covariance, options));
}

/** Hierarchical Risk Parity portfolio (correlation-distance clustering + recursive bisection). */
export function hrp(covariance: Matrix, options: { budget?: number } = {}): OptimizeResult {
  requireArgumentArray('hrp', 'covariance', covariance);
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  requireClosedDataObject('hrp', 'options', options, ['budget']);
  return envelope('hrp', options.budget ?? 1, hrpSolve(covariance, options));
}

/** Kelly-optimal weights (`Σ⁻¹μ`, optionally fractional/normalized). */
export interface KellyInput {
  /** Dense stored-data ArrayLike; values are snapshotted without coercion. */
  mean: ArrayLike<number>;
  covariance: Matrix;
  options?: KellyOptions;
}

export function kelly(input: KellyInput): OptimizeResult {
  requireClosedDataObject('kelly', 'input', input, ['mean', 'covariance', 'options']);
  const { mean, covariance, options: options = {} } = input;
  requireArgumentArray('kelly', 'covariance', covariance);
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  requireClosedDataObject('kelly', 'options', options, KELLY_OPTIONS_KEYS);
  return envelope(
    'kelly',
    options.budget ?? 1,
    withConditioning(kellySolve(mean, covariance, options), covariance, 'kelly'),
  );
}

/**
 * Minimize portfolio CVaR over a scenario set (Rockafellar–Uryasev, projected subgradient).
 * `value` carries the weights plus the optimized `conditionalValueAtRisk` and the `valueAtRisk` threshold; `assumptions`
 * additionally echo the tail confidence `alpha`.
 */
export function conditionalValueAtRiskOptimize(
  scenarios: number[][],
  options: CVaROptimizeOptions = {},
): CVaROptimizeResult {
  const functionName = 'conditionalValueAtRiskOptimize';
  requireDenseDataArray(functionName, 'scenarios', scenarios);
  const checkedScenarios = new Array<number[]>(scenarios.length);
  let assetCount: number | undefined;
  for (let index = 0; index < scenarios.length; index++) {
    const row = snapshotFiniteVector(
      functionName,
      `scenarios[${index}]`,
      scenarios[index],
      assetCount,
      MAX_CVAR_ASSETS,
    );
    if (index === 0 && row.length === 0) {
      throw new InputError(
        `${functionName}: each scenario must list at least one asset return; scenarios[0] is empty.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: 'scenarios[0]', length: 0 },
        },
      );
    }
    assetCount ??= row.length;
    checkedScenarios[index] = row;
  }
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  requireClosedDataObject(functionName, 'options', options, CVAR_OPTIMIZE_OPTIONS_KEYS);
  const s = cvarOptimizeSolve(checkedScenarios, options);
  const base = envelope(functionName, options.budget ?? 1, s);
  return {
    value: {
      ...base.value,
      conditionalValueAtRisk: s.conditionalValueAtRisk,
      valueAtRisk: s.valueAtRisk,
    },
    assumptions: { ...base.assumptions, confidence: options.alpha ?? 0.95 },
    diagnostics: base.diagnostics,
  };
}
