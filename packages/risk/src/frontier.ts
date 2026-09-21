/**
 * The constrained mean-variance efficient frontier (FC7 slice 4, Stage 4.4), traced by composing
 * the existing optimizers plus a covariance-independent linear maximum-return endpoint:
 *
 *   • the left endpoint is `minVariance` under the same constraints;
 *   • every interior point is `meanVariance` at some risk aversion λ — sweeping λ under a fixed
 *     constraint set traces the frontier, and a target expected return is met by monotone
 *     bisection on λ (the solved return is non-increasing in λ);
 *   • the tangency point, when a per-period risk-free rate is supplied, is `maxSharpe`.
 *
 * The grid is explicit (`'risk-aversion'` values, `'target-return'` values, or an evenly spaced
 * `'points'` count between the minimum-variance return and the maximum achievable return) — a
 * missing goal is a typed refusal, not a secret default. Every point is kept in grid order,
 * including the ones that could not be solved: an unreachable target is a `feasible: false`
 * point whose `reason` names the achievable range; a non-finite solve is a failed point. The
 * sweep itself never throws past input validation and never carries a non-finite number.
 */

import {
  CONVENTIONS_VERSION,
  type Diagnostics,
  ErrorCode,
  InputError,
  type QuantWarning,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
  requireRepresentableResult,
  warning,
  WarningCode,
} from '@totalfinance/core';
import type { Matrix } from '@totalfinance/math';
import { describeInputValue } from './input-description.js';
import { assertSquare, dot, quadForm } from './linalg.js';
import { snapshotFiniteVector } from './numeric-vector.js';
import { OPTIMIZE_CONSTRAINTS_KEYS, validateOptimizeConstraints } from './optimizer-validation.js';
import {
  maxSharpe,
  meanVariance,
  minVariance,
  type MeanVarianceOptions,
  type OptimizeConstraints,
  type OptimizeResult,
} from './optimize.js';

/** How the frontier is sampled — an explicit choice, never defaulted. */
export type EfficientFrontierGrid =
  /** One point per risk aversion λ in `max μᵀw − (λ/2)·wᵀΣw` (each > 0). */
  | { kind: 'risk-aversion'; values: number[] }
  /** One point per target expected return, in the units of `mean`. */
  | { kind: 'target-return'; values: number[] }
  /**
   * `count` (≥ 2, ≤ 10,000) targets evenly spaced from the minimum-variance return to the maximum
   * achievable return under the constraints. When that maximum is unbounded or cannot be proved
   * from the supported constraint grammar, the points fall back to a logarithmic λ grid and the
   * result says which case occurred.
   */
  | { kind: 'points'; count: number };

export type EfficientFrontierGridKind = EfficientFrontierGrid['kind'];

/**
 * Frontier constraints are the shared feasible-region grammar. Linear transaction costs are an
 * objective penalty, not a feasible-region constraint, and therefore belong in a direct
 * `meanVariance` solve rather than a gross mean-variance frontier.
 */
export type EfficientFrontierConstraints = Omit<OptimizeConstraints, 'transactionCosts'>;

export interface EfficientFrontierInput {
  /** Per-asset expected returns as a dense stored-data ArrayLike (same period as covariance). */
  mean: ArrayLike<number>;
  /** Asset return covariance Σ (n×n). */
  covariance: Matrix;
  grid: EfficientFrontierGrid;
  /** The optimizer's feasible-region grammar (`longOnly`, `bounds`, `budget`, `groups`, …). */
  constraints?: EfficientFrontierConstraints;
  /**
   * Risk-free rate in the SAME per-period units as `mean` (a daily problem takes 0.04/252, not
   * 0.04) — the `maxSharpe` spelling. When present every point reports a Sharpe ratio and the
   * tangency portfolio is solved and reported under `value.tangency`.
   */
  riskFreeRatePerPeriod?: number;
}

/** One solved (or failed) portfolio on the frontier. */
export interface FrontierPortfolio {
  /** `null` when the point failed (unreachable target or a non-finite solve). */
  weights: number[] | null;
  expectedReturn: number | null;
  variance: number | null;
  volatility: number | null;
  /** `(expectedReturn − riskFreeRatePerPeriod) / volatility`; `null` without a rate or at zero volatility. */
  sharpeRatio: number | null;
  /** The underlying solver converged AND (for targets) the requested return was met. */
  converged: boolean;
  /** Solver iterations spent on this point (all bisection solves included). */
  iterations: number;
  /** Whether the point satisfies the constraint set (budget, box, groups, turnover). */
  feasible: boolean;
  /** Why the point failed or did not converge. */
  reason?: string;
  warnings: QuantWarning[];
}

export interface FrontierPoint extends FrontierPortfolio {
  /** Position in the grid. */
  index: number;
  /** What this point was asked to be. */
  requested: { riskAversion?: number; targetReturn?: number };
}

export interface EfficientFrontierValue {
  /** Every point, in grid order — failed points included. */
  points: FrontierPoint[];
  /** The left endpoint: the minimum-variance portfolio under the constraints. */
  minimumVariance: FrontierPortfolio;
  /** The maximum-Sharpe (tangency) portfolio — present when `riskFreeRatePerPeriod` was given. */
  tangency?: FrontierPortfolio;
  /**
   * The expected-return range the frontier spans under the constraints: the minimum-variance
   * return and the maximum achievable return (`null` when unbounded or not determinable).
   */
  expectedReturnRange: { minimum: number | null; maximum: number | null };
  solvedCount: number;
  failedCount: number;
}

export interface EfficientFrontierResult {
  value: EfficientFrontierValue;
  assumptions: {
    conventionsVersion: string;
    objective: 'mean-variance';
    budget: number;
    grid: { kind: EfficientFrontierGridKind; count: number };
    riskFreeRatePerPeriod?: number;
    /** Prose summary of the constraint set every point was solved under. */
    constraintSummary: string;
  };
  diagnostics: Diagnostics & {
    /** Every solved point converged (false when any point failed or stopped early). */
    converged: boolean;
    /** Total solver iterations across the sweep. */
    iterations: number;
    solvedCount: number;
    failedCount: number;
    /** Volatility is non-decreasing with expected return across the solved points. */
    monotone: boolean;
    /** `true` when finite, `false` when unbounded, `null` when the proof is undetermined. */
    maximumReturnBounded: boolean | null;
  };
}

const FUNCTION_NAME = 'efficientFrontier';

const INPUT_KEYS = ['mean', 'covariance', 'grid', 'constraints', 'riskFreeRatePerPeriod'] as const;

const GRID_KINDS: readonly EfficientFrontierGridKind[] = [
  'risk-aversion',
  'target-return',
  'points',
];

/**
 * First-stage cap on the number of requested points. The aggregate solve budget below is the
 * decisive cap because a target point contains a bisection of full constrained solves.
 */
const MAX_FRONTIER_POINTS = 10_000;

/** Maximum aggregate outer solver iterations licensed by one synchronous frontier call. */
const MAX_FRONTIER_WORK_UNITS = 10_000_000;

/**
 * Conservative primitive-operation budget: covariance mat-vecs scale with n²; a general
 * constraint projection may run 500 Dykstra cycles across every convex set, each O(n).
 */
const MAX_FRONTIER_OPERATION_UNITS = 12_000_000_000;

/** Actual hard caps in the optimizer projectors and endpoint simplex. */
const MAX_AFFINE_BOX_PROJECTION_SWEEPS = 600;
const MAX_DYKSTRA_CYCLES = 500;
const MAX_LINEAR_PROGRAM_OPERATIONS = 50_000_000;

/** The mean-variance/minimum-variance default when the caller does not state a cap. */
const DEFAULT_SOLVER_ITERATIONS = 5_000;

/** Constrained maxSharpe performs at most 65 grid + 2 seed + 40 refinement solves. */
const MAX_TANGENCY_SOLVES = 107;

/** Scale-relative bisection bracket on log₁₀ λ for target-return points. */
const LOG_LAMBDA_RELATIVE_LOW = -16;
const LOG_LAMBDA_RELATIVE_HIGH = 16;
const MAX_BISECTION_STEPS = 64;

/** λ grid used for `'points'` when the maximum return is unbounded/unknown: [10⁻², 10²]. */
const FALLBACK_LOG_LAMBDA_RANGE: readonly [number, number] = [-2, 2];

/** Tolerance below which a point counts as satisfying the constraint set. */
const FEASIBILITY_TOL = 1e-6;

/** Relative tolerance for "the solved return equals the target" and endpoint identification. */
const TARGET_RELATIVE_TOL = 1e-10;

const fail = (message: string, code: string, context: Record<string, unknown>): never => {
  throw new InputError(`${FUNCTION_NAME}: ${message}`, { code, context });
};

const hasOwnProperty = Object.prototype.hasOwnProperty;

/** Plain stored-data object guard for this facade's nested request grammar. */
function requireDataObject(field: string, value: unknown, consumed: readonly string[]): void {
  requireArgumentObject(FUNCTION_NAME, field, value);
  const record = value as object;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${field} must be a plain object of stored data.`, ErrorCode.InputWrongType, { field });
  }
  for (const key of Reflect.ownKeys(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (
      typeof key !== 'string' ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      fail(
        `${field} must contain only enumerable string-keyed stored data; accessors, hidden fields, and symbols are not frontier inputs.`,
        ErrorCode.InputWrongShape,
        { field },
      );
    }
  }
  for (const key of consumed) {
    if (hasOwnProperty.call(record, key) || !(key in record)) continue;
    fail(
      `${field}.${key} is inherited rather than an own field — state every frontier input explicitly.`,
      ErrorCode.InputWrongShape,
      { field: `${field}.${key}` },
    );
  }
}

/** Dense stored-data arrays for the grid grammar (no sparse/accessor/decorated arrays). */
function requireDataArray(field: string, value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    fail(`${field} must be a plain array.`, ErrorCode.InputWrongType, { field });
  }
  const array = value as unknown[];
  if (Object.getPrototypeOf(array) !== Array.prototype) {
    fail(`${field} must be a plain array.`, ErrorCode.InputWrongType, { field });
  }
  for (let index = 0; index < array.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      fail(
        `${field} must be a dense array of stored values; index ${index} is missing or accessor-backed.`,
        ErrorCode.InputWrongShape,
        { field: `${field}[${index}]` },
      );
    }
  }
  for (const key of Reflect.ownKeys(array)) {
    if (key === 'length') continue;
    const index = typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : -1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= array.length) {
      fail(
        `${field} must contain only its dense indexed values; ${String(key)} is not grid data.`,
        ErrorCode.InputWrongShape,
        { field },
      );
    }
  }
}

// ───────────────────────── validation ─────────────────────────

function validateGrid(grid: unknown): EfficientFrontierGrid {
  if (grid === undefined) {
    fail(
      `grid is required — { kind: 'risk-aversion', values } | { kind: 'target-return', values } | { kind: 'points', count }. There is no default sampling of the frontier.`,
      ErrorCode.InputMissingField,
      { field: 'grid' },
    );
  }
  requireDataObject('grid', grid, ['kind', 'count', 'values']);
  const record = grid as Record<string, unknown>;
  const kind = record['kind'];
  if (kind === undefined) {
    fail(
      `grid.kind is required — one of ${GRID_KINDS.map((k) => `'${k}'`).join(' | ')}.`,
      ErrorCode.InputMissingField,
      { field: 'grid.kind' },
    );
  }
  if (typeof kind !== 'string' || !(GRID_KINDS as readonly string[]).includes(kind)) {
    const received = describeInputValue(kind);
    fail(
      `grid.kind must be one of ${GRID_KINDS.map((k) => `'${k}'`).join(' | ')}. Received ${received}.`,
      ErrorCode.InputInvalidEnum,
      { field: 'grid.kind', received },
    );
  }
  if (kind === 'points') {
    ensureKnownKeys(FUNCTION_NAME, 'grid', grid as object, ['kind', 'count']);
    const count = record['count'];
    if (count === undefined) {
      fail(`grid.count is required for grid.kind 'points'.`, ErrorCode.InputMissingField, {
        field: 'grid.count',
      });
    }
    // A count is a work budget (2026-08-23 review, P0): safe integer, ≥ 2, and capped.
    if (
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 2 ||
      count > MAX_FRONTIER_POINTS
    ) {
      fail(
        `grid.count must be a safe integer in [2, ${MAX_FRONTIER_POINTS.toLocaleString('en-US')}] (each point is a full constrained mean-variance solve, so the count is a work budget; two points are the frontier's endpoints), got ${describeInputValue(count)}.`,
        ErrorCode.InputOutOfRange,
        { received: describeInputValue(count), min: 2, max: MAX_FRONTIER_POINTS },
      );
    }
    return { kind: 'points', count: count as number };
  }
  ensureKnownKeys(FUNCTION_NAME, 'grid', grid as object, ['kind', 'values']);
  const values = record['values'];
  if (values === undefined) {
    fail(`grid.values is required for grid.kind '${kind}'.`, ErrorCode.InputMissingField, {
      field: 'grid.values',
    });
  }
  requireDataArray('grid.values', values);
  const list = values;
  if (list.length === 0) {
    fail(`grid.values must list at least one ${kind} value.`, ErrorCode.InputWrongShape, {
      field: 'grid.values',
      length: 0,
    });
  }
  if (list.length > MAX_FRONTIER_POINTS) {
    fail(
      `grid.values lists ${list.length.toLocaleString('en-US')} points; the sweep is capped at ${MAX_FRONTIER_POINTS.toLocaleString('en-US')} (each point is a full constrained solve).`,
      ErrorCode.InputOutOfRange,
      { points: list.length, max: MAX_FRONTIER_POINTS },
    );
  }
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      fail(
        `grid.values[${i}] must be a finite number, got ${describeInputValue(v)}.`,
        ErrorCode.InputNotFinite,
        { field: 'grid.values', index: i, received: describeInputValue(v) },
      );
    }
    if (kind === 'risk-aversion' && !((v as number) > 0)) {
      fail(
        `grid.values[${i}] must be > 0 for grid.kind 'risk-aversion' (λ scales the variance penalty), got ${v}.`,
        ErrorCode.InputOutOfRange,
        { field: 'grid.values', index: i, received: v },
      );
    }
  }
  return kind === 'risk-aversion'
    ? { kind: 'risk-aversion', values: (list as number[]).slice() }
    : { kind: 'target-return', values: (list as number[]).slice() };
}

/** The mean vector: correct length and all finite (the optimizers' own teaching, replicated). */
function requireMeanVector(mean: ArrayLike<number>, n: number): number[] {
  return snapshotFiniteVector(FUNCTION_NAME, 'mean', mean, n);
}

function pointCountOf(grid: EfficientFrontierGrid): number {
  return grid.kind === 'points' ? grid.count : grid.values.length;
}

/**
 * Refuse the PRODUCT of point count, target bisection depth, endpoint work, tangency work, and the
 * caller's per-solve iteration cap. Independent coordinate caps do not bound their product.
 */
function requireFrontierWorkBudget(
  grid: EfficientFrontierGrid,
  constraints: OptimizeConstraints,
  includesTangency: boolean,
  assetCount: number,
  maximumReturnBounded: boolean | null,
): void {
  const maximumIterations = constraints.maximumIterations ?? DEFAULT_SOLVER_ITERATIONS;
  const points = pointCountOf(grid);
  const pointSolves =
    grid.kind === 'risk-aversion'
      ? points
      : grid.kind === 'target-return'
        ? points * MAX_BISECTION_STEPS
        : maximumReturnBounded === true
          ? // Two finite endpoints are reused without a mean-variance solve. If either endpoint
            // cannot be produced, the implementation falls back to one risk-aversion solve per
            // requested point, so retain that branch in the upper bound too.
            Math.max(points, Math.max(0, points - 2) * MAX_BISECTION_STEPS)
          : points;
  const hasInequality = Boolean(
    constraints.longOnly ||
    constraints.bounds ||
    constraints.groups?.length ||
    constraints.turnover,
  );
  const tangencySolves = includesTangency ? (hasInequality ? MAX_TANGENCY_SOLVES : 1) : 0;
  // One minimum-variance solve, the branch-accurate grid work, and optional tangency work. The
  // linear endpoint has its own independent primitive-operation cap below rather than pretending
  // it performs projected-gradient iterations.
  const solverCalls = 1 + pointSolves + tangencySolves;
  const workUnits = solverCalls * maximumIterations;
  const hasGeneralProjection = Boolean(constraints.groups?.length || constraints.turnover);
  const constraintSetCount =
    2 +
    (constraints.groups ?? []).reduce(
      (count, group) =>
        count + (group.min !== undefined ? 1 : 0) + (group.max !== undefined ? 1 : 0),
      0,
    ) +
    (constraints.turnover !== undefined ? 1 : 0);
  // The affine-box projector performs TWO 200-step bracketing loops plus 200 bisections (600), not
  // 64. General constraints perform 500 Dykstra cycles; a turnover set sorts n magnitudes in every
  // cycle. Add one n² covariance mat-vec per outer iteration, a conservative 4n³ factorization /
  // conditioning setup per solver call, and the endpoint simplex's independent 50m cap.
  const projectionOperations = hasGeneralProjection
    ? MAX_DYKSTRA_CYCLES *
      (constraintSetCount * assetCount +
        (constraints.turnover !== undefined
          ? assetCount * Math.max(1, Math.ceil(Math.log2(Math.max(2, assetCount))))
          : 0))
    : MAX_AFFINE_BOX_PROJECTION_SWEEPS * assetCount;
  const operationsPerIteration = assetCount * assetCount + projectionOperations;
  const setupOperations = solverCalls * 4 * assetCount ** 3;
  const endpointOperations = maximumReturnBounded === true ? MAX_LINEAR_PROGRAM_OPERATIONS : 0;
  const operationUnits =
    workUnits * operationsPerIteration +
    solverCalls * projectionOperations +
    setupOperations +
    endpointOperations;
  if (
    workUnits > MAX_FRONTIER_WORK_UNITS ||
    operationUnits > MAX_FRONTIER_OPERATION_UNITS ||
    !Number.isSafeInteger(operationUnits)
  ) {
    fail(
      `grid, asset dimension, and constraints combine to at most ${workUnits.toLocaleString('en-US')} constrained-solver iterations (${solverCalls.toLocaleString('en-US')} possible solves × ${maximumIterations.toLocaleString('en-US')} iterations) and ${Number.isFinite(operationUnits) ? operationUnits.toLocaleString('en-US') : 'more than Number.MAX_SAFE_INTEGER'} primitive operation units (n² covariance work plus ${hasGeneralProjection ? `up to ${MAX_DYKSTRA_CYCLES} Dykstra cycles across ${constraintSetCount} constraint sets${constraints.turnover !== undefined ? ' including the turnover sort' : ''}` : `${MAX_AFFINE_BOX_PROJECTION_SWEEPS} affine-box bracket/bisection sweeps`}, factorization setup, and the bounded endpoint LP). This synchronous call's aggregate budgets are ${MAX_FRONTIER_WORK_UNITS.toLocaleString('en-US')} solver iterations and ${MAX_FRONTIER_OPERATION_UNITS.toLocaleString('en-US')} operation units. Reduce the grid count/values, lower constraints.maximumIterations, simplify the constraint set, or split independent frontier requests explicitly.`,
      ErrorCode.InputOutOfRange,
      {
        field: 'grid',
        points,
        assetCount,
        solverCalls,
        maximumIterations,
        tangencySolves,
        maximumReturnBounded,
        workUnits,
        maximumWorkUnits: MAX_FRONTIER_WORK_UNITS,
        constraintSetCount,
        projectionOperations,
        operationsPerIteration,
        setupOperations,
        endpointOperations,
        operationUnits,
        maximumOperationUnits: MAX_FRONTIER_OPERATION_UNITS,
      },
    );
  }
}

/**
 * Re-throw an optimizer's input refusal under this function's name so the teaching names the
 * boundary the caller actually touched; the code and context are preserved.
 */
function refuseAsFrontier(error: unknown): never {
  if (error instanceof InputError) {
    throw new InputError(`${FUNCTION_NAME}: ${error.message}`, {
      code: error.code,
      context: { ...(error.context ?? {}), function: FUNCTION_NAME },
    });
  }
  throw error;
}

// ───────────────────────── feasibility & boundedness under the constraint grammar ─────────────────────────

function resolveBoxBounds(n: number, c: OptimizeConstraints): { lo: number[]; hi: number[] } {
  if (c.bounds) return { lo: c.bounds.map((b) => b[0]), hi: c.bounds.map((b) => b[1]) };
  const lo = c.longOnly ? 0 : Number.NEGATIVE_INFINITY;
  return {
    lo: new Array<number>(n).fill(lo),
    hi: new Array<number>(n).fill(Number.POSITIVE_INFINITY),
  };
}

/**
 * Maximum absolute violation of the constraint set by `w` (0 ⇒ feasible): budget equality, box,
 * group caps, turnover budget — the same measure the optimizers use to refuse a fabricated success.
 */
function constraintViolation(w: number[], budget: number, c: OptimizeConstraints): number {
  const n = w.length;
  const { lo, hi } = resolveBoxBounds(n, c);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(w[i]!)) return Infinity;
    sum += w[i]!;
  }
  let v = Math.abs(sum - budget);
  for (let i = 0; i < n; i++) v = Math.max(v, lo[i]! - w[i]!, w[i]! - hi[i]!);
  for (const g of c.groups ?? []) {
    let s = 0;
    for (const m of g.members) s += w[m]!;
    if (g.max !== undefined) v = Math.max(v, s - g.max);
    if (g.min !== undefined) v = Math.max(v, g.min - s);
  }
  if (c.turnover) {
    let t = 0;
    for (let i = 0; i < n; i++) t += Math.abs(w[i]! - c.turnover.previousWeights[i]!);
    v = Math.max(v, t - c.turnover.max);
  }
  return v;
}

interface ReturnBoundedness {
  bounded: boolean | null;
  iterations: number;
}

/**
 * Fold singleton groups into their equivalent per-asset bounds. Aggregate/overlapping groups are
 * retained as a separate flag: they can remove an otherwise-unbounded recession direction, but
 * proving that requires a general LP certificate rather than a heuristic optimizer run.
 */
interface EndpointBounds {
  lo: number[];
  hi: number[];
  hasAggregateGroups: boolean;
}

function resolveEndpointBounds(n: number, c: OptimizeConstraints): EndpointBounds {
  const { lo, hi } = resolveBoxBounds(n, c);
  let hasAggregateGroups = false;
  for (const group of c.groups ?? []) {
    if (group.members.length !== 1) {
      hasAggregateGroups = true;
      continue;
    }
    const member = group.members[0]!;
    if (group.min !== undefined) lo[member] = Math.max(lo[member]!, group.min);
    if (group.max !== undefined) hi[member] = Math.min(hi[member]!, group.max);
  }
  return { lo, hi, hasAggregateGroups };
}

/**
 * Prove whether EXPECTED RETURN is bounded without consulting covariance or an iterative solver.
 * Under a budget equality and a box, return is unbounded exactly when weight can flow without
 * limit from a lower-mean, unbounded-below asset to a higher-mean, unbounded-above asset. A finite
 * turnover ball is compact. Aggregate groups may remove such a direction; until a general LP
 * certificate exists, that case is honestly `null` (unknown), never falsely called unbounded.
 */
function maximumReturnBounded(problem: Problem): ReturnBoundedness {
  const { mu, constraints } = problem;
  if (constraints.turnover) return { bounded: true, iterations: 0 };
  const { lo, hi, hasAggregateGroups } = resolveEndpointBounds(mu.length, constraints);
  let boxAllowsPositiveRecession = false;
  for (let receiver = 0; receiver < mu.length && !boxAllowsPositiveRecession; receiver++) {
    if (hi[receiver] !== Number.POSITIVE_INFINITY) continue;
    for (let donor = 0; donor < mu.length; donor++) {
      if (
        receiver !== donor &&
        lo[donor] === Number.NEGATIVE_INFINITY &&
        mu[receiver]! > mu[donor]!
      ) {
        boxAllowsPositiveRecession = true;
        break;
      }
    }
  }
  if (!boxAllowsPositiveRecession) return { bounded: true, iterations: 0 };
  if (hasAggregateGroups) return { bounded: null, iterations: 0 };
  return { bounded: false, iterations: 0 };
}

function constraintSummary(n: number, c: OptimizeConstraints, budget: number): string {
  const parts: string[] = [`budget ${budget}`];
  if (c.bounds) parts.push(`${n} per-asset [lower, upper] bounds`);
  else if (c.longOnly) parts.push('long-only (weights ≥ 0)');
  else parts.push('no box (weights unbounded above and below)');
  if (c.groups?.length) parts.push(`${c.groups.length} group exposure cap(s)`);
  if (c.turnover) parts.push(`turnover ≤ ${c.turnover.max} against previous weights`);
  if (c.maximumIterations !== undefined) parts.push(`maximumIterations ${c.maximumIterations}`);
  if (c.tolerance !== undefined) parts.push(`tolerance ${c.tolerance}`);
  return parts.join('; ');
}

// ───────────────────────── portfolio measurement ─────────────────────────

interface Problem {
  mu: number[];
  covariance: Matrix;
  constraints: OptimizeConstraints;
  budget: number;
  riskFreeRatePerPeriod: number | undefined;
}

const failedPortfolio = (
  reason: string,
  warnings: QuantWarning[],
  iterations = 0,
): FrontierPortfolio => ({
  weights: null,
  expectedReturn: null,
  variance: null,
  volatility: null,
  sharpeRatio: null,
  converged: false,
  iterations,
  feasible: false,
  reason,
  warnings,
});

/** Measure a solver result into a frontier portfolio; a non-finite anywhere makes it a failed one. */
function measure(problem: Problem, result: OptimizeResult, solverName: string): FrontierPortfolio {
  const weights = result.value.weights;
  const iterations = result.diagnostics.iterations ?? 0;
  const warnings = result.diagnostics.warnings;
  if (weights.length !== problem.mu.length || weights.some((w) => !Number.isFinite(w))) {
    return failedPortfolio(
      `${solverName} produced non-finite weights — the point is reported as failed rather than carrying NaN into the frontier.`,
      warnings,
      iterations,
    );
  }
  const expectedReturn = dot(problem.mu, weights);
  const variance = quadForm(problem.covariance, weights);
  const volatility = Math.sqrt(Math.max(0, variance));
  if (!Number.isFinite(expectedReturn) || !Number.isFinite(variance)) {
    return failedPortfolio(
      `${solverName} weights give a non-finite expected return or variance (the input magnitudes overflow the arithmetic) — reported as a failed point.`,
      warnings,
      iterations,
    );
  }
  let sharpeRatio: number | null = null;
  if (problem.riskFreeRatePerPeriod !== undefined) {
    sharpeRatio =
      volatility > 0 ? (expectedReturn - problem.riskFreeRatePerPeriod) / volatility : null;
    if (sharpeRatio !== null && !Number.isFinite(sharpeRatio)) {
      return failedPortfolio(
        `${solverName} weights give a non-finite Sharpe ratio — reported as a failed point.`,
        warnings,
        iterations,
      );
    }
  }
  const violation = constraintViolation(weights, problem.budget, problem.constraints);
  const feasible = violation <= FEASIBILITY_TOL;
  const converged = (result.diagnostics.converged ?? false) && feasible;
  const solverReason = warnings.find((w) => w.code === 'optimize.not_converged')?.context?.[
    'reason'
  ];
  const reason = !feasible
    ? `${solverName} could not satisfy the constraint set (maximum violation ${violation.toExponential(2)}) — the feasible region is empty or the solver stopped outside it.`
    : !converged
      ? `${solverName} stopped without converging${typeof solverReason === 'string' ? ` (${solverReason})` : ''}.`
      : undefined;
  return {
    weights,
    expectedReturn,
    variance,
    volatility,
    sharpeRatio,
    converged,
    iterations,
    feasible,
    ...(reason !== undefined ? { reason } : {}),
    warnings: [
      ...warnings,
      ...(problem.riskFreeRatePerPeriod !== undefined && volatility === 0
        ? [
            warning(
              WarningCode.RiskZeroVolatilitySharpe,
              `${FUNCTION_NAME}: the portfolio has zero volatility, so its Sharpe ratio is undefined (reported as null).`,
              'info',
              { expectedReturn },
            ),
          ]
        : []),
    ],
  };
}

/** Solve `meanVariance` at risk aversion λ under the problem's constraint set. */
function solveAtRiskAversion(problem: Problem, riskAversion: number): FrontierPortfolio {
  const options: MeanVarianceOptions = { ...problem.constraints, riskAversion };
  const result = meanVariance({ mean: problem.mu, covariance: problem.covariance, options });
  return measure(problem, result, `meanVariance (λ = ${riskAversion.toExponential(3)})`);
}

const withRequested = (
  portfolio: FrontierPortfolio,
  index: number,
  requested: FrontierPoint['requested'],
): FrontierPoint => ({ index, requested, ...portfolio });

const nearlyEqual = (a: number, b: number): boolean =>
  Math.abs(a - b) <= TARGET_RELATIVE_TOL * Math.max(1, Math.abs(a), Math.abs(b));

// ───────────────────────── endpoints ─────────────────────────

interface MaximumReturnSolution {
  portfolio: FrontierPortfolio | null;
  iterations: number;
  reason?: string;
}

/**
 * Derive finite coordinate bounds from the hard constraint grammar. A turnover ball bounds each
 * coordinate directly. Otherwise, finite lower (upper) bounds plus the budget equality imply an
 * upper (lower) bound for every coordinate. This proves compactness for the common long-only +
 * sector-cap problem without pretending arbitrary overlapping groups imply individual bounds.
 */
function finiteEndpointBounds(problem: Problem): { bounds: [number, number][] } | null {
  const { lo, hi } = resolveEndpointBounds(problem.mu.length, problem.constraints);
  const turnover = problem.constraints.turnover;
  if (turnover) {
    for (let index = 0; index < lo.length; index++) {
      lo[index] = Math.max(lo[index]!, turnover.previousWeights[index]! - turnover.max);
      hi[index] = Math.min(hi[index]!, turnover.previousWeights[index]! + turnover.max);
    }
  }

  if (lo.every(Number.isFinite)) {
    const totalLower = lo.reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(totalLower)) return null;
    for (let index = 0; index < hi.length; index++) {
      hi[index] = Math.min(hi[index]!, problem.budget - (totalLower - lo[index]!));
    }
  }
  if (hi.every(Number.isFinite)) {
    const totalUpper = hi.reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(totalUpper)) return null;
    for (let index = 0; index < lo.length; index++) {
      lo[index] = Math.max(lo[index]!, problem.budget - (totalUpper - hi[index]!));
    }
  }
  if (!lo.every(Number.isFinite) || !hi.every(Number.isFinite)) return null;

  const bounds: [number, number][] = [];
  for (let index = 0; index < lo.length; index++) {
    if (lo[index]! > hi[index]!) return null;
    bounds.push([lo[index]!, hi[index]!]);
  }
  return { bounds };
}

/** Affine-normalize expected returns to [0, 1] without overflowing on large finite means. */
function normalizedExpectedReturnObjective(mean: number[]): number[] | null {
  let magnitude = 0;
  for (const value of mean) magnitude = Math.max(magnitude, Math.abs(value));
  if (magnitude === 0) return null;
  const scaled = mean.map((value) => value / magnitude);
  let minimum = scaled[0]!;
  let maximum = scaled[0]!;
  for (const value of scaled) {
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  const spread = maximum - minimum;
  return spread === 0 ? null : scaled.map((value) => (value - minimum) / spread);
}

type LinearProgramResult =
  | { status: 'optimal'; solution: number[]; pivots: number }
  | { status: 'infeasible' | 'unbounded' | 'work-limit' | 'numerical'; pivots: number };

const LINEAR_PROGRAM_EPSILON = 1e-10;
const MAX_LINEAR_PROGRAM_TABLEAU_CELLS = 2_000_000;

/** Two-phase simplex for `max objective·x` subject to `A·x ≤ b`, `x ≥ 0`. */
function solveLinearProgram(input: {
  coefficients: number[][];
  bounds: number[];
  objective: number[];
  maximumPivots: number;
}): LinearProgramResult {
  const { coefficients: A, bounds: b, objective, maximumPivots } = input;
  const rowCount = b.length;
  const variableCount = objective.length;
  const cells = (rowCount + 2) * (variableCount + 2);
  if (
    cells > MAX_LINEAR_PROGRAM_TABLEAU_CELLS ||
    A.some(
      (row, index) =>
        row.length !== variableCount ||
        !Number.isFinite(b[index]) ||
        row.some((value) => !Number.isFinite(value)),
    ) ||
    objective.some((value) => !Number.isFinite(value))
  ) {
    return { status: 'numerical', pivots: 0 };
  }
  const operationBound = Math.max(
    1,
    Math.floor(MAX_LINEAR_PROGRAM_OPERATIONS / Math.max(1, cells)),
  );
  const pivotLimit = Math.min(maximumPivots, operationBound);
  if (pivotLimit < 1) return { status: 'work-limit', pivots: 0 };

  const basic = new Array<number>(rowCount);
  const nonBasic = new Array<number>(variableCount + 1);
  const tableau = Array.from({ length: rowCount + 2 }, () =>
    new Array<number>(variableCount + 2).fill(0),
  );
  for (let row = 0; row < rowCount; row++) {
    for (let column = 0; column < variableCount; column++) {
      tableau[row]![column] = A[row]![column]!;
    }
    basic[row] = variableCount + row;
    tableau[row]![variableCount] = -1;
    tableau[row]![variableCount + 1] = b[row]!;
  }
  for (let column = 0; column < variableCount; column++) {
    nonBasic[column] = column;
    tableau[rowCount]![column] = -objective[column]!;
  }
  nonBasic[variableCount] = -1;
  tableau[rowCount + 1]![variableCount] = 1;
  let pivots = 0;
  let numericalFailure = false;

  const pivot = (pivotRow: number, pivotColumn: number): boolean => {
    if (pivots >= pivotLimit) return false;
    const value = tableau[pivotRow]![pivotColumn]!;
    if (!Number.isFinite(value) || Math.abs(value) <= LINEAR_PROGRAM_EPSILON) {
      numericalFailure = true;
      return false;
    }
    const inverse = 1 / value;
    for (let row = 0; row < rowCount + 2; row++) {
      if (row === pivotRow) continue;
      for (let column = 0; column < variableCount + 2; column++) {
        if (column === pivotColumn) continue;
        tableau[row]![column] =
          tableau[row]![column]! -
          tableau[pivotRow]![column]! * tableau[row]![pivotColumn]! * inverse;
      }
    }
    for (let column = 0; column < variableCount + 2; column++) {
      if (column !== pivotColumn) {
        tableau[pivotRow]![column] = tableau[pivotRow]![column]! * inverse;
      }
    }
    for (let row = 0; row < rowCount + 2; row++) {
      if (row !== pivotRow) {
        tableau[row]![pivotColumn] = tableau[row]![pivotColumn]! * -inverse;
      }
    }
    tableau[pivotRow]![pivotColumn] = inverse;
    const previousBasic = basic[pivotRow]!;
    basic[pivotRow] = nonBasic[pivotColumn]!;
    nonBasic[pivotColumn] = previousBasic;
    pivots++;
    if (tableau.some((row) => row.some((value) => !Number.isFinite(value)))) {
      numericalFailure = true;
      return false;
    }
    return true;
  };

  const runPhase = (phase: 1 | 2): 'optimal' | 'unbounded' | 'stopped' => {
    const objectiveRow = phase === 1 ? rowCount + 1 : rowCount;
    while (true) {
      let entering = -1;
      for (let column = 0; column <= variableCount; column++) {
        if (phase === 2 && nonBasic[column] === -1) continue;
        if (
          entering < 0 ||
          tableau[objectiveRow]![column]! <
            tableau[objectiveRow]![entering]! - LINEAR_PROGRAM_EPSILON ||
          (Math.abs(tableau[objectiveRow]![column]! - tableau[objectiveRow]![entering]!) <=
            LINEAR_PROGRAM_EPSILON &&
            nonBasic[column]! < nonBasic[entering]!)
        ) {
          entering = column;
        }
      }
      if (entering < 0 || tableau[objectiveRow]![entering]! >= -LINEAR_PROGRAM_EPSILON) {
        return 'optimal';
      }
      let leaving = -1;
      for (let row = 0; row < rowCount; row++) {
        const coefficient = tableau[row]![entering]!;
        if (coefficient <= LINEAR_PROGRAM_EPSILON) continue;
        if (leaving < 0) {
          leaving = row;
          continue;
        }
        const ratio = tableau[row]![variableCount + 1]! / coefficient;
        const currentRatio = tableau[leaving]![variableCount + 1]! / tableau[leaving]![entering]!;
        if (
          ratio < currentRatio - LINEAR_PROGRAM_EPSILON ||
          (Math.abs(ratio - currentRatio) <= LINEAR_PROGRAM_EPSILON &&
            basic[row]! < basic[leaving]!)
        ) {
          leaving = row;
        }
      }
      if (leaving < 0) return 'unbounded';
      if (!pivot(leaving, entering)) return 'stopped';
    }
  };

  let mostNegativeRow = 0;
  for (let row = 1; row < rowCount; row++) {
    if (tableau[row]![variableCount + 1]! < tableau[mostNegativeRow]![variableCount + 1]!) {
      mostNegativeRow = row;
    }
  }
  if (rowCount > 0 && tableau[mostNegativeRow]![variableCount + 1]! < -LINEAR_PROGRAM_EPSILON) {
    if (!pivot(mostNegativeRow, variableCount)) {
      return { status: numericalFailure ? 'numerical' : 'work-limit', pivots };
    }
    const phaseOne = runPhase(1);
    if (phaseOne === 'stopped') {
      return { status: numericalFailure ? 'numerical' : 'work-limit', pivots };
    }
    if (
      phaseOne === 'unbounded' ||
      tableau[rowCount + 1]![variableCount + 1]! < -LINEAR_PROGRAM_EPSILON
    ) {
      return { status: 'infeasible', pivots };
    }
    for (let row = 0; row < rowCount; row++) {
      if (basic[row] !== -1) continue;
      let entering = 0;
      for (let column = 1; column <= variableCount; column++) {
        if (
          Math.abs(tableau[row]![column]!) >
            Math.abs(tableau[row]![entering]!) + LINEAR_PROGRAM_EPSILON ||
          (Math.abs(Math.abs(tableau[row]![column]!) - Math.abs(tableau[row]![entering]!)) <=
            LINEAR_PROGRAM_EPSILON &&
            nonBasic[column]! < nonBasic[entering]!)
        ) {
          entering = column;
        }
      }
      if (Math.abs(tableau[row]![entering]!) > LINEAR_PROGRAM_EPSILON && !pivot(row, entering)) {
        return { status: numericalFailure ? 'numerical' : 'work-limit', pivots };
      }
    }
  }
  const phaseTwo = runPhase(2);
  if (phaseTwo === 'stopped') {
    return { status: numericalFailure ? 'numerical' : 'work-limit', pivots };
  }
  if (phaseTwo === 'unbounded') return { status: 'unbounded', pivots };
  const solution = new Array<number>(variableCount).fill(0);
  for (let row = 0; row < rowCount; row++) {
    if (basic[row]! >= 0 && basic[row]! < variableCount) {
      solution[basic[row]!] = tableau[row]![variableCount + 1]!;
    }
  }
  return { status: 'optimal', solution, pivots };
}

/** General covariance-independent LP endpoint for aggregate groups and turnover constraints. */
function solveCertifiedMaximumReturn(problem: Problem): MaximumReturnSolution {
  const compact = finiteEndpointBounds(problem);
  if (compact === null) {
    return {
      portfolio: null,
      iterations: 0,
      reason:
        'the hard constraints do not yield finite coordinate bounds for a scale-independent endpoint certificate',
    };
  }
  const objective = normalizedExpectedReturnObjective(problem.mu);
  if (objective === null) {
    return {
      portfolio: null,
      iterations: 0,
      reason: 'the expected-return objective has no representable cross-asset spread',
    };
  }
  const assetCount = problem.mu.length;
  const hasTurnover = problem.constraints.turnover !== undefined;
  const variableCount = assetCount + (hasTurnover ? assetCount : 0);
  const coefficients: number[][] = [];
  const bounds: number[] = [];
  const addConstraint = (entries: Array<[number, number]>, bound: number): boolean => {
    if (!Number.isFinite(bound)) return false;
    const row = new Array<number>(variableCount).fill(0);
    for (const [index, coefficient] of entries) row[index] = coefficient;
    coefficients.push(row);
    bounds.push(bound);
    return true;
  };
  const lower = compact.bounds.map(([value]) => value);
  const upper = compact.bounds.map(([, value]) => value);
  for (let index = 0; index < assetCount; index++) {
    if (!addConstraint([[index, 1]], upper[index]! - lower[index]!)) {
      return { portfolio: null, iterations: 0, reason: 'a shifted weight bound overflowed' };
    }
  }
  const lowerSum = lower.reduce((sum, value) => sum + value, 0);
  const shiftedBudget = problem.budget - lowerSum;
  const budgetEntries = lower.map((_, index) => [index, 1] as [number, number]);
  if (
    !addConstraint(budgetEntries, shiftedBudget) ||
    !addConstraint(
      budgetEntries.map(([index]) => [index, -1]),
      -shiftedBudget,
    )
  ) {
    return { portfolio: null, iterations: 0, reason: 'the shifted budget overflowed' };
  }
  for (const group of problem.constraints.groups ?? []) {
    const entries = group.members.map((member) => [member, 1] as [number, number]);
    const lowerInGroup = group.members.reduce((sum, member) => sum + lower[member]!, 0);
    if (
      (group.max !== undefined && !addConstraint(entries, group.max - lowerInGroup)) ||
      (group.min !== undefined &&
        !addConstraint(
          entries.map(([index]) => [index, -1]),
          lowerInGroup - group.min,
        ))
    ) {
      return { portfolio: null, iterations: 0, reason: 'a shifted group bound overflowed' };
    }
  }
  if (problem.constraints.turnover) {
    const turnover = problem.constraints.turnover;
    for (let index = 0; index < assetCount; index++) {
      const auxiliary = assetCount + index;
      const shiftedPrevious = turnover.previousWeights[index]! - lower[index]!;
      if (
        !addConstraint(
          [
            [index, 1],
            [auxiliary, -1],
          ],
          shiftedPrevious,
        ) ||
        !addConstraint(
          [
            [index, -1],
            [auxiliary, -1],
          ],
          -shiftedPrevious,
        )
      ) {
        return { portfolio: null, iterations: 0, reason: 'a shifted turnover bound overflowed' };
      }
    }
    if (
      !addConstraint(
        lower.map((_, index) => [assetCount + index, 1]),
        turnover.max,
      )
    ) {
      return { portfolio: null, iterations: 0, reason: 'the turnover budget overflowed' };
    }
  }
  const lp = solveLinearProgram({
    coefficients,
    bounds,
    objective: [...objective, ...(hasTurnover ? new Array<number>(assetCount).fill(0) : [])],
    maximumPivots: problem.constraints.maximumIterations ?? DEFAULT_SOLVER_ITERATIONS,
  });
  if (lp.status !== 'optimal') {
    return {
      portfolio: null,
      iterations: lp.pivots,
      reason: `the linear maximum-return endpoint stopped with status '${lp.status}'`,
    };
  }
  const weights = lower.map((value, index) => value + lp.solution[index]!);
  const portfolio = { ...exactEndpointPortfolio(problem, weights), iterations: lp.pivots };
  if (!portfolio.converged) {
    return {
      portfolio: null,
      iterations: lp.pivots,
      reason: portfolio.reason ?? 'the linear endpoint failed its post-solve feasibility audit',
    };
  }
  return { portfolio, iterations: lp.pivots };
}

/**
 * Maximize a linear objective over a budget equality and per-asset box by transferring weight from
 * the lowest-return donors to the highest-return receivers. Starting from any feasible point, this
 * is the continuous-knapsack optimum. A finite `transferLimit` adds an L1 turnover ball around the
 * starting portfolio: each unit moved consumes two units of L1 turnover.
 */
function maximizeExpectedReturnByTransfers(
  mean: number[],
  start: number[],
  lo: number[],
  hi: number[],
  transferLimit: number,
  budget: number,
): number[] | null {
  const weights = start.slice();
  // Iterative solvers may return a feasible point a few ulps off the budget plane. Repair that
  // residue before the exact transfer solve so an endpoint at a literal bound remains literal.
  let budgetResidue = budget - weights.reduce((sum, weight) => sum + weight, 0);
  for (let index = 0; index < weights.length && budgetResidue !== 0; index++) {
    const capacity =
      budgetResidue > 0 ? hi[index]! - weights[index]! : weights[index]! - lo[index]!;
    if (!(capacity > 0)) continue;
    const adjustment = Math.sign(budgetResidue) * Math.min(Math.abs(budgetResidue), capacity);
    weights[index] = weights[index]! + adjustment;
    budgetResidue -= adjustment;
  }
  if (Math.abs(budgetResidue) > FEASIBILITY_TOL) return null;
  const donors = mean.map((_, index) => index).sort((a, b) => mean[a]! - mean[b]! || a - b);
  const receivers = donors.slice().reverse();
  let donorCursor = 0;
  let receiverCursor = 0;
  let remaining = transferLimit;

  while (donorCursor < donors.length && receiverCursor < receivers.length && remaining > 0) {
    const donor = donors[donorCursor]!;
    const receiver = receivers[receiverCursor]!;
    if (donor === receiver || !(mean[receiver]! > mean[donor]!)) break;

    const donorCapacity = Math.max(0, weights[donor]! - lo[donor]!);
    const receiverCapacity = Math.max(0, hi[receiver]! - weights[receiver]!);
    if (donorCapacity === 0) {
      donorCursor++;
      continue;
    }
    if (receiverCapacity === 0) {
      receiverCursor++;
      continue;
    }

    const amount = Math.min(donorCapacity, receiverCapacity, remaining);
    // An infinite transfer is precisely an unbounded direction. It should have been classified
    // before this solve; returning null keeps a numerical edge case from fabricating an endpoint.
    if (!(amount > 0) || !Number.isFinite(amount)) return null;
    weights[donor] = weights[donor]! - amount;
    weights[receiver] = weights[receiver]! + amount;
    if (!Number.isFinite(weights[donor]) || !Number.isFinite(weights[receiver])) return null;
    if (Number.isFinite(remaining)) remaining = Math.max(0, remaining - amount);

    if (amount >= donorCapacity) donorCursor++;
    if (amount >= receiverCapacity) receiverCursor++;
  }
  return weights;
}

function exactEndpointPortfolio(problem: Problem, weights: number[]): FrontierPortfolio {
  const result: OptimizeResult = {
    value: { weights, objective: dot(problem.mu, weights) },
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      objective: 'maximum-expected-return',
      budget: problem.budget,
    },
    diagnostics: { converged: true, iterations: 0, warnings: [] },
  };
  return measure(problem, result, 'linear maximum-return endpoint');
}

/**
 * Compute the covariance-independent maximum-return endpoint exactly for box/budget constraints,
 * singleton groups, and the common turnover case whose base portfolio is itself feasible. More
 * general aggregate groups or an off-budget turnover base are returned as undetermined rather than
 * approximated with an arbitrary risk-aversion ladder.
 */
function solveMaximumReturn(problem: Problem, minimum: FrontierPortfolio): MaximumReturnSolution {
  const { lo, hi, hasAggregateGroups } = resolveEndpointBounds(
    problem.mu.length,
    problem.constraints,
  );
  let start = minimum.weights;
  let transferLimit = Number.POSITIVE_INFINITY;
  if (problem.constraints.turnover) {
    start = problem.constraints.turnover.previousWeights;
    transferLimit = problem.constraints.turnover.max / 2;
    const baseBudgetGap = Math.abs(start.reduce((sum, weight) => sum + weight, 0) - problem.budget);
    if (
      baseBudgetGap > 1e-12 ||
      constraintViolation(start, problem.budget, problem.constraints) > FEASIBILITY_TOL
    ) {
      return solveCertifiedMaximumReturn(problem);
    }
  }
  if (hasAggregateGroups) return solveCertifiedMaximumReturn(problem);
  if (start === null) {
    return {
      portfolio: null,
      iterations: 0,
      reason: 'no feasible starting portfolio was available',
    };
  }
  const weights = maximizeExpectedReturnByTransfers(
    problem.mu,
    start,
    lo,
    hi,
    transferLimit,
    problem.budget,
  );
  if (weights === null) {
    return {
      portfolio: null,
      iterations: 0,
      reason: 'the exact linear endpoint exceeded finite-number representation',
    };
  }
  return { portfolio: exactEndpointPortfolio(problem, weights), iterations: 0 };
}

// ───────────────────────── target-return points ─────────────────────────

interface Range {
  minimum: FrontierPortfolio | null;
  maximum: FrontierPortfolio | null;
  bounded: boolean | null;
}

const describeRange = (range: Range): string => {
  const low = range.minimum?.expectedReturn;
  const high = range.maximum?.expectedReturn;
  const upper =
    range.bounded === false
      ? 'unbounded'
      : high === null || high === undefined
        ? 'unknown'
        : String(high);
  return `[${low === null || low === undefined ? 'unknown' : String(low)}, ${upper}${range.bounded === false ? ')' : ']'}`;
};

/**
 * Center target-return bisection on the scale ratio `mean spread / covariance magnitude`. This
 * makes an internal target request invariant to quoting covariance in e.g. unit, percent, or basis
 * point squared terms. Explicit risk-aversion grids retain the caller's literal λ semantics.
 */
function targetRiskAversionLogCenter(problem: Problem): number {
  let meanMagnitude = 0;
  for (const value of problem.mu) meanMagnitude = Math.max(meanMagnitude, Math.abs(value));
  let normalizedSpread = 0;
  if (meanMagnitude > 0) {
    const anchor = problem.mu[0]! / meanMagnitude;
    for (const value of problem.mu) {
      normalizedSpread = Math.max(normalizedSpread, Math.abs(value / meanMagnitude - anchor));
    }
  }
  let covarianceMagnitude = 0;
  for (const row of problem.covariance) {
    for (const value of row) covarianceMagnitude = Math.max(covarianceMagnitude, Math.abs(value));
  }
  if (meanMagnitude === 0 || normalizedSpread === 0 || covarianceMagnitude === 0) return 0;
  const center =
    Math.log10(meanMagnitude) + Math.log10(normalizedSpread) - Math.log10(covarianceMagnitude);
  // Keep the full relative bracket representable as a positive finite JavaScript number.
  return Math.max(-280, Math.min(280, center));
}

/** Solve one target expected return by monotone bisection on log₁₀ λ. */
function solveTargetReturn(problem: Problem, target: number, range: Range): FrontierPortfolio {
  const minimum = range.minimum;
  if (minimum === null || minimum.expectedReturn === null) {
    return failedPortfolio(
      `target ${target} cannot be placed: the minimum-variance endpoint failed (${minimum?.reason ?? 'no solution'}), so the achievable range is unknown.`,
      [],
    );
  }
  const low = minimum.expectedReturn;
  if (nearlyEqual(target, low)) return { ...minimum, iterations: 0 };
  if (target < low) {
    return failedPortfolio(
      `target expected return ${target} is below the minimum-variance portfolio's ${low} — the efficient frontier starts there; achievable range ${describeRange(range)}.`,
      [],
    );
  }
  if (range.bounded === true && range.maximum !== null && range.maximum.expectedReturn !== null) {
    const high = range.maximum.expectedReturn;
    if (nearlyEqual(target, high)) return { ...range.maximum, iterations: 0 };
    if (target > high) {
      return failedPortfolio(
        `target expected return ${target} exceeds the maximum achievable ${high} under the constraints — achievable range ${describeRange(range)}.`,
        [],
      );
    }
  }

  // return(λ) is non-increasing in λ under a fixed constraint set: bisect log₁₀ λ around
  // the problem's mean/covariance scale, not an absolute ladder tied to one unit convention.
  const logCenter = targetRiskAversionLogCenter(problem);
  let logLow = logCenter + LOG_LAMBDA_RELATIVE_LOW; // return here ≥ target
  let logHigh = logCenter + LOG_LAMBDA_RELATIVE_HIGH; // return here ≤ target
  let iterations = 0;
  let closest: FrontierPortfolio | null = null;
  let closestGap = Infinity;
  const tolerance = TARGET_RELATIVE_TOL * Math.max(1, Math.abs(target));
  for (let step = 0; step < MAX_BISECTION_STEPS; step++) {
    const logMid = 0.5 * (logLow + logHigh);
    const candidate = solveAtRiskAversion(problem, 10 ** logMid);
    iterations += candidate.iterations;
    if (candidate.expectedReturn === null) {
      return { ...candidate, iterations };
    }
    const gap = Math.abs(candidate.expectedReturn - target);
    if (gap < closestGap) {
      closest = candidate;
      closestGap = gap;
    }
    if (gap <= tolerance) break;
    if (candidate.expectedReturn > target) logLow = logMid;
    else logHigh = logMid;
  }
  const point = closest!;
  const met = closestGap <= tolerance;
  const converged = point.converged && met;
  const reason = !met
    ? `scale-relative bisection on λ ∈ [1e${logCenter + LOG_LAMBDA_RELATIVE_LOW}, 1e${logCenter + LOG_LAMBDA_RELATIVE_HIGH}] closed to within ${closestGap.toExponential(2)} of target ${target} (closest solved return ${point.expectedReturn}) without meeting it.`
    : point.reason;
  return {
    ...point,
    iterations,
    converged,
    ...(reason !== undefined ? { reason } : {}),
  };
}

// ───────────────────────── the facade ─────────────────────────

/**
 * Trace the constrained mean-variance efficient frontier by composing `minVariance`,
 * `meanVariance`, and (with a risk-free rate) `maxSharpe` under ONE constraint set.
 *
 * ```ts
 * efficientFrontier({
 *   mean,
 *   covariance,
 *   grid: { kind: 'points', count: 20 },
 *   constraints: { longOnly: true },
 *   riskFreeRatePerPeriod: 0.04 / 252,
 * });
 * ```
 *
 * `value.points` keeps every grid point in order; a target outside the achievable range is a
 * `feasible: false` point whose `reason` names the range, never a throw. `diagnostics.monotone`
 * reports whether volatility rises with expected return across the solved points (the shape a
 * correct frontier has) and names the first violation in a warning when it does not.
 */
export function efficientFrontier(input: EfficientFrontierInput): EfficientFrontierResult {
  requireDataObject('input', input, INPUT_KEYS);
  ensureKnownKeys(FUNCTION_NAME, 'input', input, INPUT_KEYS);
  const { mean, covariance, constraints: rawConstraints, riskFreeRatePerPeriod } = input;
  requireArgumentArray(FUNCTION_NAME, 'covariance', covariance);
  const n = covariance.length;
  if (n === 0 || !Array.isArray(covariance[0])) {
    fail(
      'covariance must be a non-empty square matrix (at least one asset).',
      ErrorCode.InputWrongShape,
      { rows: n },
    );
  }
  assertSquare(covariance, n, FUNCTION_NAME);
  const mu = requireMeanVector(mean, n);
  if (rawConstraints !== undefined) {
    requireDataObject('constraints', rawConstraints, OPTIMIZE_CONSTRAINTS_KEYS);
    ensureKnownKeys(FUNCTION_NAME, 'constraints', rawConstraints, OPTIMIZE_CONSTRAINTS_KEYS);
    if ((rawConstraints as OptimizeConstraints).transactionCosts !== undefined) {
      fail(
        `constraints.transactionCosts is not part of an efficient frontier: it changes the objective relative to one previous portfolio, so mixing cost-penalized interior solves with a gross maximum-return endpoint would not describe one coherent frontier. Use meanVariance directly for a cost-aware rebalance, or omit transactionCosts to trace the gross mean-variance frontier.`,
        ErrorCode.InputOutOfRange,
        { field: 'constraints.transactionCosts' },
      );
    }
  }
  const constraints: OptimizeConstraints = rawConstraints ?? {};
  // Validate the complete shared grammar without solving. The work estimator below may inspect
  // nested groups/turnover, and malformed input must receive the optimizer's canonical teaching
  // before any work or nested property access occurs.
  validateOptimizeConstraints(constraints, FUNCTION_NAME, n);
  if (
    riskFreeRatePerPeriod !== undefined &&
    (typeof riskFreeRatePerPeriod !== 'number' || !Number.isFinite(riskFreeRatePerPeriod))
  ) {
    fail(
      `riskFreeRatePerPeriod must be a finite number in the per-period units of mean, got ${describeInputValue(riskFreeRatePerPeriod)}.`,
      ErrorCode.InputNotFinite,
      { received: describeInputValue(riskFreeRatePerPeriod) },
    );
  }
  const grid = validateGrid(input.grid);
  const budget = constraints.budget ?? 1;
  const problem: Problem = { mu, covariance, constraints, budget, riskFreeRatePerPeriod };
  const boundedness = maximumReturnBounded(problem);
  const bounded = boundedness.bounded;
  requireFrontierWorkBudget(grid, constraints, riskFreeRatePerPeriod !== undefined, n, bounded);

  // The left endpoint. Constraint validation and aggregate-work refusal have already completed, so
  // no hostile request can buy a solver run merely to discover malformed grammar or excessive work.
  let minimumResult: OptimizeResult;
  try {
    minimumResult = minVariance(covariance, constraints);
  } catch (error) {
    refuseAsFrontier(error);
  }
  const minimum = measure(problem, minimumResult, 'minVariance');
  const warnings: QuantWarning[] = [];
  let totalIterations = minimum.iterations + boundedness.iterations;
  let maximum: FrontierPortfolio | null = null;
  let maximumFailureReason: string | undefined;
  if (bounded === true && minimum.feasible) {
    const endpoint = solveMaximumReturn(problem, minimum);
    maximum = endpoint.portfolio;
    maximumFailureReason = endpoint.reason;
    totalIterations += endpoint.iterations;
  }
  const range: Range = { minimum: minimum.feasible ? minimum : null, maximum, bounded };

  // ---- the sweep ----
  const points: FrontierPoint[] = [];
  let gridKind: EfficientFrontierGridKind = grid.kind;
  if (grid.kind === 'risk-aversion') {
    grid.values.forEach((riskAversion, index) => {
      const portfolio = solveAtRiskAversion(problem, riskAversion);
      points.push(withRequested(portfolio, index, { riskAversion }));
    });
  } else if (grid.kind === 'target-return') {
    grid.values.forEach((targetReturn, index) => {
      const portfolio = solveTargetReturn(problem, targetReturn, range);
      points.push(withRequested(portfolio, index, { targetReturn }));
    });
  } else {
    const count = grid.count;
    const low = range.minimum?.expectedReturn ?? null;
    const high = range.maximum?.expectedReturn ?? null;
    if (bounded === true && low !== null && high !== null) {
      for (let index = 0; index < count; index++) {
        const targetReturn =
          index === count - 1 ? high : low + ((high - low) * index) / (count - 1);
        const portfolio = solveTargetReturn(problem, targetReturn, range);
        points.push(withRequested(portfolio, index, { targetReturn }));
      }
    } else {
      // No finite maximum to span to: fall back to a logarithmic λ grid, descending so expected
      // return rises left to right, and say so — never throw, never guess a range.
      gridKind = 'risk-aversion';
      const [logLow, logHigh] = FALLBACK_LOG_LAMBDA_RANGE;
      const rangeUnknown = bounded !== false;
      warnings.push(
        warning(
          rangeUnknown ? 'risk.frontier_return_range_unknown' : 'risk.frontier_unbounded_return',
          rangeUnknown
            ? `${FUNCTION_NAME}: the maximum achievable return could not be certified (${maximumFailureReason ?? minimum.reason ?? 'aggregate group constraints need a general linear-program certificate'}), so the ${count} points are a logarithmic risk-aversion grid over [1e${logLow}, 1e${logHigh}] (descending) instead of evenly spaced target returns.`
            : `${FUNCTION_NAME}: the maximum achievable return is unbounded under these box, group, budget, and turnover constraints, so the ${count} points are a logarithmic risk-aversion grid over [1e${logLow}, 1e${logHigh}] (descending) instead of evenly spaced target returns. Add bounds, group limits, longOnly, or a turnover budget that caps the positive-return leverage direction.`,
          'warn',
          { count, bounded, riskAversionRange: [10 ** logLow, 10 ** logHigh] },
        ),
      );
      for (let index = 0; index < count; index++) {
        const logLambda = logHigh - ((logHigh - logLow) * index) / (count - 1);
        const riskAversion = 10 ** logLambda;
        const portfolio = solveAtRiskAversion(problem, riskAversion);
        points.push(withRequested(portfolio, index, { riskAversion }));
      }
    }
  }
  for (const point of points) totalIterations += point.iterations;

  // ---- tangency ----
  let tangency: FrontierPortfolio | undefined;
  if (riskFreeRatePerPeriod !== undefined) {
    let tangencyResult: OptimizeResult;
    try {
      tangencyResult = maxSharpe({
        mean: mu,
        covariance,
        options: { ...constraints, riskFreeRatePerPeriod },
      });
    } catch (error) {
      refuseAsFrontier(error);
    }
    tangency = measure(problem, tangencyResult, 'maxSharpe');
    totalIterations += tangency.iterations;
  }

  // ---- diagnostics ----
  const solved = points.filter((p) => p.weights !== null);
  const solvedCount = solved.length;
  const failedCount = points.length - solvedCount;
  const converged =
    points.length > 0 && failedCount === 0 && points.every((point) => point.converged);
  let monotone = true;
  const ordered = solved
    .slice()
    .sort((a, b) => a.expectedReturn! - b.expectedReturn! || a.index - b.index);
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    const slack = 1e-9 * Math.max(1, previous.volatility!);
    if (current.volatility! < previous.volatility! - slack) {
      monotone = false;
      warnings.push(
        warning(
          WarningCode.RiskFrontierNotMonotone,
          `${FUNCTION_NAME}: volatility is not non-decreasing with expected return — point ${current.index} (return ${current.expectedReturn}, volatility ${current.volatility}) sits below point ${previous.index} (return ${previous.expectedReturn}, volatility ${previous.volatility}). A point that did not converge, or an ill-conditioned covariance, usually explains it.`,
          'warn',
          {
            pointIndex: current.index,
            previousPointIndex: previous.index,
            expectedReturn: current.expectedReturn,
            volatility: current.volatility,
            previousVolatility: previous.volatility,
          },
        ),
      );
      break;
    }
  }
  if (failedCount > 0) {
    warnings.push(
      warning(
        WarningCode.RiskFrontierPointsFailed,
        `${FUNCTION_NAME}: ${failedCount} of ${points.length} points failed (see each point's reason) — unreachable targets and non-finite solves are reported, not thrown.`,
        'warn',
        {
          failedCount,
          failedIndices: points.filter((p) => p.weights === null).map((p) => p.index),
        },
      ),
    );
  }

  const result: EfficientFrontierResult = {
    value: {
      points,
      minimumVariance: minimum,
      ...(tangency !== undefined ? { tangency } : {}),
      expectedReturnRange: {
        minimum: range.minimum?.expectedReturn ?? null,
        maximum: bounded === true ? (maximum?.expectedReturn ?? null) : null,
      },
      solvedCount,
      failedCount,
    },
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      objective: 'mean-variance',
      budget,
      grid: { kind: gridKind, count: points.length },
      ...(riskFreeRatePerPeriod !== undefined ? { riskFreeRatePerPeriod } : {}),
      constraintSummary: constraintSummary(n, constraints, budget),
    },
    diagnostics: {
      warnings,
      converged,
      iterations: totalIterations,
      solvedCount,
      failedCount,
      monotone,
      maximumReturnBounded: bounded,
    },
  };
  // Law 7 finalizer: every number in the envelope is finite by construction (failed points are
  // null-with-reason); the finalizer makes that a checked postcondition, not a promise.
  return requireRepresentableResult(FUNCTION_NAME, result);
}
