/**
 * Numerical integration (spec §8.4).
 *
 * Adaptive Simpson (error-controlled) and fixed-order Gauss–Legendre quadrature (nodes/weights
 * computed by Newton iteration on the Legendre polynomials, cached per order).
 */

import {
  InputError,
  ensureKnownKeys,
  requireArgumentObject,
  ConvergenceError,
  ErrorCode,
  ensureFinite,
} from '@totalfinance/core';
import { requireGaussLegendreNodeCount } from './resource-validation.js';
import type { ScalarFunction } from './solvers.js';

export interface AdaptiveSimpsonOptions {
  tolerance?: number;
  maxDepth?: number;
  /**
   * Maximum integrand evaluations before stopping with `converged: false`. Default 100,000.
   *
   * `maxDepth` bounds the DEPTH of a binary subdivision, so it bounds the work at 2^depth — the
   * default of 50 therefore permits about 10^15 evaluations, which is a budget in name only. This is
   * the bound that actually holds.
   */
  maxEvaluations?: number;
}

export interface AdaptiveSimpsonResult {
  /** The integral estimate (best available even when `converged` is false). */
  value: number;
  /** Whether every subinterval met its (halved) tolerance before the depth budget ran out. */
  converged: boolean;
  /** The deepest recursion level reached (0 = no subdivision). */
  deepestLevel: number;
}

/**
 * Adaptive Simpson integration returning diagnostics instead of throwing. The tolerance is HALVED at
 * each recursion level so the total error stays bounded by `tolerance` regardless of how many subintervals
 * are created; depth exhaustion is reported via `converged: false` rather than being indistinguishable
 * from success.
 */
export function adaptiveSimpsonSafe(
  integrand: ScalarFunction,
  lowerBound: number,
  upperBound: number,
  options: AdaptiveSimpsonOptions = {},
): AdaptiveSimpsonResult {
  // Front door (shared with adaptiveSimpson, which delegates here): a missing integrand used to
  // crash deep in the first evaluation, and `{ maxDepth: null }` silently ran the default budget.
  if (typeof integrand !== 'function') {
    throw new InputError(
      `adaptiveSimpson: integrand must be a function — adaptiveSimpson((x) => x * x, 0, 1). Received ${integrand === null ? 'null' : typeof integrand}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'integrand' } },
    );
  }
  requireArgumentObject('adaptiveSimpson', 'options', options);
  ensureKnownKeys('adaptiveSimpson', 'options', options, [
    'tolerance',
    'maxDepth',
    'maxEvaluations',
  ]);
  for (const field of ['tolerance', 'maxDepth', 'maxEvaluations'] as const) {
    const value = (options as Record<string, unknown>)[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new InputError(
        `adaptiveSimpson: ${field} must be a finite number when provided — omit the field to use the default. Received ${value === null ? 'null' : typeof value}.`,
        { code: ErrorCode.InputWrongType, context: { field } },
      );
    }
  }
  /**
   * NON-FINITE BOUNDS DO NOT RETURN. Found by the contract harness, reproduced by hand:
   * `adaptiveSimpsonSafe(f, NaN, 1)` never comes back, while the same call on `[1, 1]` and `[0, 1]`
   * answers in under a millisecond.
   *
   * The mechanism is worth stating, because the depth budget reads like protection against it. A NaN
   * bound makes `err` NaN; `Math.abs(NaN) <= 15 * tolerance` is false — every comparison with NaN is —
   * so the tolerance exit can never be taken and the ONLY remaining exit is depth exhaustion. The
   * recursion is binary, so reaching depth 50 that way costs 2^50 evaluations. Not an infinite loop:
   * a finite one no one will outlive.
   *
   * A caller who lets a NaN propagate into a bound therefore gets a hung process instead of an error,
   * which is the worst failure mode this library has — silent, unattributable, and indistinguishable
   * from a deadlock.
   */
  ensureFinite(lowerBound, 'lowerBound', 'adaptiveSimpson');
  ensureFinite(upperBound, 'upperBound', 'adaptiveSimpson');
  const tol0 = options.tolerance ?? 1e-10;
  const maxDepth = options.maxDepth ?? 50;
  /**
   * A budget on WORK, which `maxDepth` never was.
   *
   * Guarding the bounds fixes the NaN path and not the general one: any integrand whose error
   * estimate keeps missing tolerance subdivides exponentially, and the existing `converged: false`
   * contract already describes what to do when the budget runs out. It just needed a budget that
   * corresponds to elapsed time rather than to tree height.
   */
  const maxEvaluations = options.maxEvaluations ?? 100_000;
  let evaluations = 0;
  let converged = true;
  let deepestLevel = 0;
  const simpson = (fa: number, fm: number, fb: number, lo: number, hi: number): number =>
    ((hi - lo) / 6) * (fa + 4 * fm + fb);

  const recurse = (
    lo: number,
    hi: number,
    fa: number,
    fm: number,
    fb: number,
    whole: number,
    tolerance: number,
    depth: number,
  ): number => {
    const level = maxDepth - depth;
    if (level > deepestLevel) deepestLevel = level;
    const m = 0.5 * (lo + hi);
    const lm = 0.5 * (lo + m);
    const rm = 0.5 * (m + hi);
    const flm = integrand(lm);
    const frm = integrand(rm);
    evaluations += 2;
    const left = simpson(fa, flm, fm, lo, m);
    const right = simpson(fm, frm, fb, m, hi);
    const err = left + right - whole;
    if (Math.abs(err) <= 15 * tolerance) {
      return left + right + err / 15;
    }
    if (depth <= 0 || evaluations >= maxEvaluations) {
      converged = false; // exhausted the depth or evaluation budget before meeting tolerance
      return left + right + err / 15;
    }
    return (
      recurse(lo, m, fa, flm, fm, left, tolerance / 2, depth - 1) +
      recurse(m, hi, fm, frm, fb, right, tolerance / 2, depth - 1)
    );
  };

  const m = 0.5 * (lowerBound + upperBound);
  const fa = integrand(lowerBound);
  const fm = integrand(m);
  const fb = integrand(upperBound);
  const value = recurse(
    lowerBound,
    upperBound,
    fa,
    fm,
    fb,
    simpson(fa, fm, fb, lowerBound, upperBound),
    tol0,
    maxDepth,
  );
  return { value, converged, deepestLevel };
}

/**
 * Adaptive Simpson integration of `f` on `[a, b]` to the requested tolerance. Throws
 * `ConvergenceError` (`integration.max_depth`) if the depth budget is exhausted before the tolerance
 * is met — use {@link adaptiveSimpsonSafe} for a soft result with diagnostics.
 */
export function adaptiveSimpson(
  integrand: ScalarFunction,
  lowerBound: number,
  upperBound: number,
  options: AdaptiveSimpsonOptions = {},
): number {
  const result = adaptiveSimpsonSafe(integrand, lowerBound, upperBound, options);
  if (!result.converged) {
    throw new ConvergenceError(
      'adaptiveSimpson: reached max recursion depth before meeting the tolerance.',
      {
        code: ErrorCode.IntegrationMaxDepth,
        context: { maxDepth: options.maxDepth ?? 50, deepestLevel: result.deepestLevel },
      },
    );
  }
  return result.value;
}

interface Quadrature {
  nodes: number[];
  weights: number[];
}

const glCache = new Map<number, Quadrature>();

/**
 * Gauss–Legendre nodes and weights on `[-1, 1]` for `n` points, as a FRESH pair of arrays.
 *
 * The rule is computed once per order and memoized, but the cached arrays are never handed out: a
 * caller who scaled the returned nodes in place (the obvious way to map them onto `[a, b]`) used to
 * corrupt the shared cache, and every later integral at that order — anywhere in the process —
 * silently integrated against the mutated rule. A copy per call costs `2n` doubles; the alternative
 * is a global that any caller can poison.
 */
export function gaussLegendreNodes(nodeCount: number): Quadrature {
  requireGaussLegendreNodeCount('gaussLegendreNodes', nodeCount);
  const cached = glCache.get(nodeCount);
  if (cached) return { nodes: cached.nodes.slice(), weights: cached.weights.slice() };
  const nodes = new Array<number>(nodeCount);
  const weights = new Array<number>(nodeCount);
  const m = (nodeCount + 1) >> 1;
  for (let i = 0; i < m; i++) {
    // initial guess for the i-th root
    let x = Math.cos((Math.PI * (i + 0.75)) / (nodeCount + 0.5));
    let dp = 0;
    for (let iter = 0; iter < 100; iter++) {
      // Legendre P_n(x) and derivative via recurrence
      let p0 = 1;
      let p1 = x;
      for (let k = 2; k <= nodeCount; k++) {
        const p2 = ((2 * k - 1) * x * p1 - (k - 1) * p0) / k;
        p0 = p1;
        p1 = p2;
      }
      dp = (nodeCount * (x * p1 - p0)) / (x * x - 1);
      const dx = p1 / dp;
      x -= dx;
      if (Math.abs(dx) < 1e-15) break;
    }
    const w = 2 / ((1 - x * x) * dp * dp);
    nodes[i] = -x;
    nodes[nodeCount - 1 - i] = x;
    weights[i] = w;
    weights[nodeCount - 1 - i] = w;
  }
  const q: Quadrature = { nodes, weights };
  glCache.set(nodeCount, q);
  return { nodes: nodes.slice(), weights: weights.slice() };
}

/** The cached rule itself — internal, read-only by convention, never returned to a caller. */
function cachedGaussLegendreNodes(nodeCount: number): Quadrature {
  const cached = glCache.get(nodeCount);
  if (cached) return cached;
  gaussLegendreNodes(nodeCount);
  return glCache.get(nodeCount)!;
}

/** Gauss–Legendre integration of `f` on `[a, b]` using `n` points (default 10). */
export function gaussLegendre(
  integrand: ScalarFunction,
  lowerBound: number,
  upperBound: number,
  nodeCount = 10,
): number {
  requireGaussLegendreNodeCount('gaussLegendre', nodeCount);
  const { nodes, weights } = cachedGaussLegendreNodes(nodeCount);
  const c1 = 0.5 * (upperBound - lowerBound);
  const c2 = 0.5 * (lowerBound + upperBound);
  let s = 0;
  for (let i = 0; i < nodeCount; i++) s += weights[i]! * integrand(c1 * nodes[i]! + c2);
  return c1 * s;
}
