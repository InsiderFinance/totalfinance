/**
 * Optimization (spec §8.4).
 *
 * Scalar minimization (golden-section, Brent), multivariate Nelder–Mead and BFGS (numerical
 * gradient + Armijo backtracking line search), and Levenberg–Marquardt least squares (numerical
 * Jacobian). All report convergence honestly.
 */

import {
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
  ErrorCode,
  InputError,
} from '@totalfinance/core';
import { mulberry32 } from './random.js';
import { requireMathIterationBudgetWhenPresent } from './resource-validation.js';
import type { ScalarFunction } from './solvers.js';

export interface MinResult {
  argMin: number;
  minimum: number;
  converged: boolean;
  iterations: number;
  /** Objective evaluations performed (interpretability parity across optimizers). */
  evaluations?: number;
  reason?: 'max_iterations' | 'non_finite';
}

export interface MultiMinResult {
  argMin: number[];
  minimum: number;
  converged: boolean;
  iterations: number;
  /** Objective evaluations performed. */
  evaluations?: number;
  /** Seeded global optimizers (differential evolution) echo the PRNG seed actually used. */
  seed?: number;
  reason?: 'max_iterations' | 'non_finite' | 'line_search_failed';
}

export interface MinOptions {
  tolerance?: number;
  maximumIterations?: number;
}

const GR = (Math.sqrt(5) - 1) / 2;

/** Golden-section minimization of a unimodal `f` on `[a, b]`. */
/**
 * The optimizer family's front door (the root-finder recipe from the solver wave): a callable
 * objective, finite positional brackets, closed options with when-present ladders — an omitted
 * objective used to crash deep in the first evaluation, and `{ maxDepth: null }`-style options
 * silently ran the defaults (the 350c2796 ruling).
 */
function requireObjective(value: unknown, functionName: string, example: string): void {
  if (typeof value !== 'function') {
    throw new InputError(
      `${functionName}: objective must be a function — ${example}. Received ${value === null ? 'null' : typeof value}.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field: 'objective' } },
    );
  }
}

function requireFiniteWhenPresentOption(value: unknown, functionName: string, field: string): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InputError(
      `${functionName}: ${field} must be a finite number when provided — omit the field to use the default. Received ${value === null ? 'null' : typeof value === 'number' ? String(value) : typeof value}.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field } },
    );
  }
}

const MIN_OPTION_KEYS = ['tolerance', 'maximumIterations', 'seed'] as const;
const MULTI_MIN_OPTION_KEYS = ['tolerance', 'maximumIterations', 'grad'] as const;
const DIFFERENTIAL_EVOLUTION_OPTION_KEYS = [
  'populationSize',
  'maxGenerations',
  'mutation',
  'crossover',
  'seed',
  'tolerance',
] as const;

function requireScalarMinInputs(
  functionName: string,
  objective: unknown,
  lowerBound: unknown,
  upperBound: unknown,
  options: Record<string, unknown>,
  allowed: readonly string[],
): void {
  requireObjective(objective, functionName, `${functionName}((x) => (x - 2) ** 2, 0, 5)`);
  for (const [name, v] of [
    ['lowerBound', lowerBound],
    ['upperBound', upperBound],
  ] as const) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new InputError(
        `${functionName}: ${name} must be a finite number — ${functionName}((x) => (x - 2) ** 2, 0, 5). Received ${v === null ? 'null' : v === undefined ? 'undefined' : typeof v === 'number' ? String(v) : typeof v}.`,
        { code: ErrorCode.InputWrongType, context: { function: functionName, field: name } },
      );
    }
  }
  requireArgumentObject(functionName, 'options', options);
  ensureKnownKeys(functionName, 'options', options, allowed);
  requireFiniteWhenPresentOption(options['tolerance'], functionName, 'tolerance');
  requireFiniteWhenPresentOption(options['maximumIterations'], functionName, 'maximumIterations');
  requireMathIterationBudgetWhenPresent(functionName, options['maximumIterations']);
}

function requireMultiMinInputs(
  functionName: string,
  objective: unknown,
  start: unknown,
  options: MultiMinOptions,
): void {
  requireObjective(
    objective,
    functionName,
    `${functionName}((p) => p[0] ** 2 + p[1] ** 2, [1, 1])`,
  );
  requireArgumentArray(functionName, 'start', start as never);
  requireArgumentObject(functionName, 'options', options);
  ensureKnownKeys(functionName, 'options', options, MULTI_MIN_OPTION_KEYS);
  requireFiniteWhenPresentOption(options.tolerance, functionName, 'tolerance');
  requireFiniteWhenPresentOption(options.maximumIterations, functionName, 'maximumIterations');
  requireMathIterationBudgetWhenPresent(functionName, options.maximumIterations);
  if (options.grad !== undefined && typeof options.grad !== 'function') {
    throw new InputError(
      `${functionName}: grad must be a gradient function when provided. Received ${options.grad === null ? 'null' : typeof options.grad}.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field: 'grad' } },
    );
  }
}

export function goldenSectionMin(
  objective: ScalarFunction,
  lowerBound: number,
  upperBound: number,
  options: MinOptions = {},
): MinResult {
  requireScalarMinInputs(
    'goldenSectionMin',
    objective,
    lowerBound,
    upperBound,
    options as Record<string, unknown>,
    MIN_OPTION_KEYS,
  );
  const tolerance = options.tolerance ?? 1e-8;
  const maximumIterations = options.maximumIterations ?? 200;
  let evals = 0;
  let bestX = 0.5 * (lowerBound + upperBound);
  let bestFx = Infinity;
  // Evaluate + track the best FINITE point, so a non-finite objective returns best-so-far rather
  // than corrupting the golden-section comparison and reporting converged:true.
  const ev = (x: number): number => {
    evals++;
    const v = objective(x);
    if (Number.isFinite(v) && v < bestFx) {
      bestFx = v;
      bestX = x;
    }
    return v;
  };
  const nonFinite = (i: number): MinResult => ({
    argMin: bestX,
    minimum: bestFx,
    converged: false,
    iterations: i,
    evaluations: evals,
    reason: 'non_finite',
  });
  let lo = lowerBound;
  let hi = upperBound;
  let c = hi - GR * (hi - lo);
  let d = lo + GR * (hi - lo);
  let fc = ev(c);
  let fd = ev(d);
  if (!Number.isFinite(fc) || !Number.isFinite(fd)) return nonFinite(0);
  for (let i = 1; i <= maximumIterations; i++) {
    if (Math.abs(hi - lo) < tolerance) {
      const x = 0.5 * (lo + hi);
      const fx = ev(x);
      if (!Number.isFinite(fx)) return nonFinite(i);
      return { argMin: x, minimum: fx, converged: true, iterations: i, evaluations: evals };
    }
    if (fc < fd) {
      hi = d;
      d = c;
      fd = fc;
      c = hi - GR * (hi - lo);
      fc = ev(c);
    } else {
      lo = c;
      c = d;
      fc = fd;
      d = lo + GR * (hi - lo);
      fd = ev(d);
    }
    if (!Number.isFinite(fc) || !Number.isFinite(fd)) return nonFinite(i);
  }
  const x = 0.5 * (lo + hi);
  const fx = ev(x);
  return {
    argMin: x,
    minimum: fx,
    converged: false,
    iterations: maximumIterations,
    evaluations: evals,
    reason: Number.isFinite(fx) ? 'max_iterations' : 'non_finite',
  };
}

/** Brent's method for 1-D minimization (parabolic interpolation with a golden-section safeguard). */
export function brentMin(
  objective: ScalarFunction,
  a0: number,
  b0: number,
  options: MinOptions = {},
): MinResult {
  requireScalarMinInputs(
    'brentMin',
    objective,
    a0,
    b0,
    options as Record<string, unknown>,
    MIN_OPTION_KEYS,
  );
  const tolerance = options.tolerance ?? 1e-10;
  const maximumIterations = options.maximumIterations ?? 200;
  const cgold = 0.3819660112501051;
  const zeps = 1e-18;
  let evals = 0;
  const ev = (xx: number): number => {
    evals++;
    return objective(xx);
  };
  let a = Math.min(a0, b0);
  let b = Math.max(a0, b0);
  let x = a + cgold * (b - a);
  let w = x;
  let v = x;
  let fx = ev(x);
  if (!Number.isFinite(fx)) {
    return {
      argMin: x,
      minimum: fx,
      converged: false,
      iterations: 0,
      evaluations: evals,
      reason: 'non_finite',
    };
  }
  let fw = fx;
  let fv = fx;
  let e = 0;
  let d = 0;
  for (let iter = 1; iter <= maximumIterations; iter++) {
    const xm = 0.5 * (a + b);
    const tol1 = tolerance * Math.abs(x) + zeps;
    const tol2 = 2 * tol1;
    if (Math.abs(x - xm) <= tol2 - 0.5 * (b - a)) {
      return { argMin: x, minimum: fx, converged: true, iterations: iter, evaluations: evals };
    }
    let useGolden = true;
    if (Math.abs(e) > tol1) {
      const r = (x - w) * (fx - fv);
      let q = (x - v) * (fx - fw);
      let p = (x - v) * q - (x - w) * r;
      q = 2 * (q - r);
      if (q > 0) p = -p;
      q = Math.abs(q);
      const etemp = e;
      e = d;
      if (!(Math.abs(p) >= Math.abs(0.5 * q * etemp) || p <= q * (a - x) || p >= q * (b - x))) {
        d = p / q;
        const u = x + d;
        if (u - a < tol2 || b - u < tol2) d = x < xm ? tol1 : -tol1;
        useGolden = false;
      }
    }
    if (useGolden) {
      e = x >= xm ? a - x : b - x;
      d = cgold * e;
    }
    const u = Math.abs(d) >= tol1 ? x + d : x + (d >= 0 ? tol1 : -tol1);
    const fu = ev(u);
    if (!Number.isFinite(fu)) {
      // `x`/`fx` is always the incumbent best; return it rather than following a NaN downhill.
      return {
        argMin: x,
        minimum: fx,
        converged: false,
        iterations: iter,
        evaluations: evals,
        reason: 'non_finite',
      };
    }
    if (fu <= fx) {
      if (u >= x) a = x;
      else b = x;
      v = w;
      fv = fw;
      w = x;
      fw = fx;
      x = u;
      fx = fu;
    } else {
      if (u < x) a = u;
      else b = u;
      if (fu <= fw || w === x) {
        v = w;
        fv = fw;
        w = u;
        fw = fu;
      } else if (fu <= fv || v === x || v === w) {
        v = u;
        fv = fu;
      }
    }
  }
  return {
    argMin: x,
    minimum: fx,
    converged: false,
    iterations: maximumIterations,
    evaluations: evals,
    reason: 'max_iterations',
  };
}

export type MultivariateFunction = (x: number[]) => number;

export interface MultiMinOptions {
  tolerance?: number;
  maximumIterations?: number;
  /** Analytic gradient; if omitted, a central-difference gradient is used (BFGS only). */
  grad?: (point: number[]) => number[];
}

function numericalGradient(f: MultivariateFunction, x: number[], h = 1e-6): number[] {
  const n = x.length;
  const g = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const step = h * (1 + Math.abs(x[i]!));
    const xp = x.slice();
    const xm = x.slice();
    xp[i] = x[i]! + step;
    xm[i] = x[i]! - step;
    g[i] = (f(xp) - f(xm)) / (2 * step);
  }
  return g;
}

/** Nelder–Mead simplex minimization (derivative-free). */
export function nelderMead(
  objective: MultivariateFunction,
  start: number[],
  options: MultiMinOptions = {},
): MultiMinResult {
  requireMultiMinInputs('nelderMead', objective, start, options);
  const tolerance = options.tolerance ?? 1e-8;
  const maximumIterations = options.maximumIterations ?? 400;
  const n = start.length;
  const alpha = 1;
  const gamma = 2;
  const rho = 0.5;
  const sigma = 0.5;

  // Objective wrapper: count evaluations, track the best FINITE vertex, and flag any non-finite value
  // so we bail before a NaN corrupts the simplex sort (which otherwise returns converged:true garbage).
  let evals = 0;
  let bestX = start.slice();
  let bestFx = Infinity;
  let aborted = false;
  const ev = (x: number[]): number => {
    evals++;
    const v = objective(x);
    if (!Number.isFinite(v)) aborted = true;
    else if (v < bestFx) {
      bestFx = v;
      bestX = x.slice();
    }
    return v;
  };
  const nonFinite = (i: number): MultiMinResult => ({
    argMin: bestX.slice(),
    minimum: bestFx,
    converged: false,
    iterations: i,
    evaluations: evals,
    reason: 'non_finite',
  });

  // Build the initial simplex.
  const simplex: number[][] = [start.slice()];
  for (let i = 0; i < n; i++) {
    const p = start.slice();
    const step = start[i] !== 0 ? 0.05 * start[i]! : 0.00025;
    p[i] = start[i]! + step;
    simplex.push(p);
  }
  let fvals = simplex.map(ev);
  if (aborted) return nonFinite(0);

  const centroid = (excl: number): number[] => {
    const c = new Array<number>(n).fill(0);
    for (let i = 0; i < simplex.length; i++) {
      if (i === excl) continue;
      for (let j = 0; j < n; j++) c[j]! += simplex[i]![j]!;
    }
    for (let j = 0; j < n; j++) c[j]! /= n;
    return c;
  };
  const combine = (a: number[], b: number[], t: number): number[] =>
    a.map((ai, j) => ai + t * (b[j]! - ai));

  let iter = 0;
  for (; iter < maximumIterations; iter++) {
    if (aborted) return nonFinite(iter); // bail before the NaN corrupts the sort below
    const order = fvals.map((v, i) => i).sort((i, j) => fvals[i]! - fvals[j]!);
    const sortedSimplex = order.map((i) => simplex[i]!);
    const sortedF = order.map((i) => fvals[i]!);
    for (let i = 0; i < simplex.length; i++) {
      simplex[i] = sortedSimplex[i]!;
      fvals[i] = sortedF[i]!;
    }
    const best = fvals[0]!;
    const worst = fvals[n]!;
    if (Math.abs(worst - best) <= tolerance * (Math.abs(best) + tolerance)) {
      return {
        argMin: simplex[0]!.slice(),
        minimum: best,
        converged: true,
        iterations: iter,
        evaluations: evals,
      };
    }
    const c = centroid(n);
    const xr = combine(c, simplex[n]!, -alpha);
    const fr = ev(xr);
    if (fr < fvals[0]!) {
      const xe = combine(c, simplex[n]!, -gamma);
      const fe = ev(xe);
      if (fe < fr) {
        simplex[n] = xe;
        fvals[n] = fe;
      } else {
        simplex[n] = xr;
        fvals[n] = fr;
      }
    } else if (fr < fvals[n - 1]!) {
      simplex[n] = xr;
      fvals[n] = fr;
    } else {
      const xc = combine(c, simplex[n]!, rho);
      const fc = ev(xc);
      if (fc < fvals[n]!) {
        simplex[n] = xc;
        fvals[n] = fc;
      } else {
        for (let i = 1; i < simplex.length; i++) {
          simplex[i] = combine(simplex[0]!, simplex[i]!, sigma);
        }
        fvals = simplex.map(ev);
      }
    }
  }
  if (aborted) return nonFinite(iter);
  let bi = 0;
  for (let i = 1; i < fvals.length; i++) if (fvals[i]! < fvals[bi]!) bi = i;
  return {
    argMin: simplex[bi]!.slice(),
    minimum: fvals[bi]!,
    converged: false,
    iterations: iter,
    evaluations: evals,
    reason: 'max_iterations',
  };
}

/** BFGS quasi-Newton minimization with a backtracking (Armijo) line search. */
export function bfgs(
  objective: MultivariateFunction,
  start: number[],
  options: MultiMinOptions = {},
): MultiMinResult {
  requireMultiMinInputs('bfgs', objective, start, options);
  const tolerance = options.tolerance ?? 1e-8;
  const maximumIterations = options.maximumIterations ?? 200;
  const n = start.length;

  // Count every objective call — including the 2n per numerical gradient, which dominate the cost of
  // a derivative-free BFGS run and are exactly what a caller comparing optimizers wants to see.
  let evaluations = 0;
  const evaluate = (point: number[]): number => {
    evaluations++;
    return objective(point);
  };
  const grad = options.grad ?? ((point: number[]) => numericalGradient(evaluate, point));

  let x = start.slice();
  let g = grad(x);
  // inverse-Hessian approximation, initialized to identity
  let H = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );

  for (let iter = 1; iter <= maximumIterations; iter++) {
    const gnorm = Math.sqrt(g.reduce((s, gi) => s + gi * gi, 0));
    if (gnorm <= tolerance)
      return {
        argMin: x,
        minimum: evaluate(x),
        converged: true,
        iterations: iter,
        evaluations,
      };

    // search direction p = -H g
    const p = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) p[i]! -= H[i]![j]! * g[j]!;

    // Armijo backtracking line search
    const fx = evaluate(x);
    const slope = g.reduce((s, gi, i) => s + gi * p[i]!, 0);
    let step = 1;
    let xNew = x;
    let fNew = fx;
    let ok = false;
    for (let ls = 0; ls < 50; ls++) {
      xNew = x.map((xi, i) => xi + step * p[i]!);
      fNew = evaluate(xNew);
      if (Number.isFinite(fNew) && fNew <= fx + 1e-4 * step * slope) {
        ok = true;
        break;
      }
      step *= 0.5;
    }
    if (!ok)
      return {
        argMin: x,
        minimum: fx,
        converged: false,
        iterations: iter,
        evaluations,
        reason: 'line_search_failed',
      };

    const gNew = grad(xNew);
    const s = xNew.map((xi, i) => xi - x[i]!);
    const y = gNew.map((gi, i) => gi - g[i]!);
    const sy = s.reduce((acc, si, i) => acc + si * y[i]!, 0);

    if (sy > 1e-12) {
      // BFGS inverse-Hessian update (Sherman–Morrison form)
      const Hy = new Array<number>(n).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Hy[i]! += H[i]![j]! * y[j]!;
      const yHy = y.reduce((acc, yi, i) => acc + yi * Hy[i]!, 0);
      const Hnew = H.map((row) => row.slice());
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          Hnew[i]![j]! +=
            ((sy + yHy) * s[i]! * s[j]!) / (sy * sy) - (Hy[i]! * s[j]! + s[i]! * Hy[j]!) / sy;
        }
      }
      H = Hnew;
    }
    x = xNew;
    g = gNew;
  }
  return {
    argMin: x,
    minimum: evaluate(x),
    converged: false,
    iterations: maximumIterations,
    evaluations,
    reason: 'max_iterations',
  };
}

export interface LevenbergMarquardtResult {
  parameters: number[];
  residualNorm: number;
  converged: boolean;
  iterations: number;
  /** Residual-vector evaluations performed (interpretability parity with the other optimizers). */
  evaluations?: number;
  reason?: 'max_iterations';
}

export interface LMOptions {
  tolerance?: number;
  maximumIterations?: number;
  lambda0?: number;
}

const LM_OPTION_KEYS = ['tolerance', 'maximumIterations', 'lambda0'] as const;

/** Solve A x = b by Gaussian elimination with partial pivoting (small dense systems). */
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    [M[col], M[pivot]] = [M[pivot]!, M[col]!];
    const diag = M[col]![col]!;
    if (diag === 0) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r]![col]! / diag;
      for (let c = col; c <= n; c++) M[r]![c]! -= factor * M[col]![c]!;
    }
  }
  const x = new Array<number>(n);
  for (let i = 0; i < n; i++) x[i] = M[i]![i]! === 0 ? 0 : M[i]![n]! / M[i]![i]!;
  return x;
}

/** Levenberg–Marquardt least-squares minimization of `||residuals(parameters)||²`. */
export function levenbergMarquardt(
  residuals: (p: number[]) => number[],
  p0: number[],
  options: LMOptions = {},
): LevenbergMarquardtResult {
  requireObjective(residuals, 'levenbergMarquardt', 'levenbergMarquardt((p) => [p[0] - 1], [0])');
  requireArgumentArray('levenbergMarquardt', 'p0', p0);
  requireArgumentObject('levenbergMarquardt', 'options', options);
  ensureKnownKeys('levenbergMarquardt', 'options', options, LM_OPTION_KEYS);
  for (const field of LM_OPTION_KEYS) {
    requireFiniteWhenPresentOption(options[field], 'levenbergMarquardt', field);
  }
  requireMathIterationBudgetWhenPresent('levenbergMarquardt', options.maximumIterations);
  const tolerance = options.tolerance ?? 1e-10;
  const maximumIterations = options.maximumIterations ?? 200;
  let lambda = options.lambda0 ?? 1e-3;
  const n = p0.length;
  let evaluations = 0;
  const evaluate = (parameters: number[]): number[] => {
    evaluations++;
    return residuals(parameters);
  };
  let p = p0.slice();
  let r = evaluate(p);
  let cost = r.reduce((s, ri) => s + ri * ri, 0);

  /**
   * Forward-difference Jacobian at `parameters`, where `base` is the ALREADY-COMPUTED residual
   * vector there. The base used to be recomputed twice per call (once for its length, once for the
   * differences) even though the caller was holding it — two full residual evaluations thrown away
   * every iteration, which on an expensive model is the dominant cost of the fit.
   */
  const jacobian = (parameters: number[], base: number[]): number[][] => {
    const m = base.length;
    const J = Array.from({ length: m }, () => new Array<number>(n).fill(0));
    for (let j = 0; j < n; j++) {
      const h = 1e-6 * (1 + Math.abs(parameters[j]!));
      const pp = parameters.slice();
      pp[j] = parameters[j]! + h;
      const rp = evaluate(pp);
      for (let i = 0; i < m; i++) J[i]![j] = (rp[i]! - base[i]!) / h;
    }
    return J;
  };

  for (let iter = 1; iter <= maximumIterations; iter++) {
    const J = jacobian(p, r);
    const m = r.length;
    // A = JᵀJ, g = Jᵀr
    const A = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    const g = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < m; k++) g[i]! += J[k]![i]! * r[k]!;
      for (let j = 0; j < n; j++) {
        let s = 0;
        for (let k = 0; k < m; k++) s += J[k]![i]! * J[k]![j]!;
        A[i]![j] = s;
      }
    }
    const gnorm = Math.sqrt(g.reduce((s, gi) => s + gi * gi, 0));
    if (gnorm <= tolerance) {
      return {
        parameters: p,
        residualNorm: Math.sqrt(cost),
        converged: true,
        iterations: iter,
        evaluations,
      };
    }

    // damped step: (A + λ diag(A)) δ = -g
    const Adamped = A.map((row, i) => row.map((v, j) => (i === j ? v + lambda * v : v)));
    const delta = solveLinear(
      Adamped,
      g.map((gi) => -gi),
    );
    const pNew = p.map((pi, i) => pi + delta[i]!);
    const rNew = evaluate(pNew);
    const costNew = rNew.reduce((s, ri) => s + ri * ri, 0);

    if (Number.isFinite(costNew) && costNew < cost) {
      const improvement = cost - costNew;
      p = pNew;
      r = rNew;
      cost = costNew;
      lambda = Math.max(lambda * 0.5, 1e-12);
      if (improvement <= tolerance * (cost + tolerance)) {
        return {
          parameters: p,
          residualNorm: Math.sqrt(cost),
          converged: true,
          iterations: iter,
          evaluations,
        };
      }
    } else {
      lambda = Math.min(lambda * 4, 1e12);
    }
  }
  return {
    parameters: p,
    residualNorm: Math.sqrt(cost),
    converged: false,
    iterations: maximumIterations,
    evaluations,
    reason: 'max_iterations',
  };
}

// ───────────────────────── differential evolution (global, seeded) ─────────────────────────

/**
 * The largest population one DE run will hold (2026-08-23 review, P0 "unbounded work"):
 * `Number.isInteger(1e308)` is `true`, so the old check let a "population size" reach
 * `Array.from({ length: NP })` as a multi-gigabyte allocation (NP × dimensions doubles, plus a trial
 * vector per member per generation). DE practice sizes NP at 5–10× the dimension count; 10^6 members
 * is orders beyond any published usage while still only ~8 MB per dimension.
 */
const MAX_DIFFERENTIAL_EVOLUTION_POPULATION = 1_000_000;

/**
 * The most objective evaluations one DE run may request, as the PRODUCT populationSize ×
 * maxGenerations (2026-08-23 review, P0 "unbounded work"): each generation evaluates every member
 * once, so the product IS the workload, and modest per-factor values multiply into an absurd total
 * (10^6 × 10^6 = 10^12 evaluations — days, for a free objective). 10^8 evaluations of even a trivial
 * arrow-function objective is ~2–4 s (a bare math closure was measured at ~37 ns/call); real
 * objectives cost µs and dominate from there.
 */
const MAX_DIFFERENTIAL_EVOLUTION_EVALUATIONS = 100_000_000;

export interface DifferentialEvolutionOptions {
  /** Population size. Default `max(20, 10·dim)`. */
  populationSize?: number;
  /** Maximum generations. Default 300. */
  maxGenerations?: number;
  /** Differential weight `F ∈ (0, 2]`. Default 0.8. */
  mutation?: number;
  /** Crossover probability `CR ∈ [0, 1]`. Default 0.9. */
  crossover?: number;
  /** Seed for the deterministic PRNG. Default 0x5eed. */
  seed?: number;
  /** Converge when the population's objective spread falls below this. Default 1e-12. */
  tolerance?: number;
}

/**
 * Differential evolution (Storn–Price `rand/1/bin`): a seeded, bound-constrained **global** optimizer
 * for multimodal objectives the local methods (Nelder–Mead/BFGS) get stuck on. Deterministic given the
 * seed; trial vectors are reflected back inside `bounds`. Returns the best member found.
 */
export function differentialEvolution(
  objective: MultivariateFunction,
  bounds: ReadonlyArray<readonly [number, number]>,
  options: DifferentialEvolutionOptions = {},
): MultiMinResult {
  requireObjective(
    objective,
    'differentialEvolution',
    'differentialEvolution((p) => p[0] ** 2, [[-5, 5]])',
  );
  requireArgumentArray('differentialEvolution', 'bounds', bounds as never);
  requireArgumentObject('differentialEvolution', 'options', options);
  ensureKnownKeys('differentialEvolution', 'options', options, DIFFERENTIAL_EVOLUTION_OPTION_KEYS);
  for (const field of DIFFERENTIAL_EVOLUTION_OPTION_KEYS) {
    requireFiniteWhenPresentOption(
      (options as Record<string, unknown>)[field],
      'differentialEvolution',
      field,
    );
  }
  const dimensions = bounds.length;
  for (const [lo, hi] of bounds) {
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
      throw new InputError(`differentialEvolution: invalid bound [${lo}, ${hi}].`, {
        code: ErrorCode.OptimizeInvalidBounds,
        context: { lowerBound: lo, upperBound: hi },
      });
    }
  }
  const NP = options.populationSize ?? Math.max(20, 10 * dimensions);
  const maxGen = options.maxGenerations ?? 300;
  const F = options.mutation ?? 0.8;
  const CR = options.crossover ?? 0.9;
  const tolerance = options.tolerance ?? 1e-12;
  const seed = options.seed ?? 0x5eed;
  // `rand/1/bin` draws three mutually distinct indices ≠ i, which needs FOUR members to exist. With
  // three or fewer, the rejection sampler below (`while (c === i || c === a || c === b) …`) can never
  // satisfy its condition and spins forever — an unkillable hang, not an error. Reject the input.
  // Safe integer AND caps (2026-08-23 review, P0): see MAX_DIFFERENTIAL_EVOLUTION_POPULATION and
  // MAX_DIFFERENTIAL_EVOLUTION_EVALUATIONS — the generation loop above 2^53 cannot terminate at all
  // (`gen++` stops advancing), and below it the old checks accepted workloads measured in days.
  if (!Number.isSafeInteger(NP) || NP < 4 || NP > MAX_DIFFERENTIAL_EVOLUTION_POPULATION) {
    throw new InputError(
      `differentialEvolution: populationSize must be an integer in [4, ${MAX_DIFFERENTIAL_EVOLUTION_POPULATION.toLocaleString('en-US')}] (rand/1/bin needs three distinct donors besides the target, and the population materializes populationSize × dimensions doubles — DE practice is 5–10× the dimension count). Received ${NP}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { populationSize: NP, max: MAX_DIFFERENTIAL_EVOLUTION_POPULATION },
      },
    );
  }
  if (!Number.isSafeInteger(maxGen) || maxGen < 1) {
    throw new InputError(
      `differentialEvolution: maxGenerations must be a positive integer (a safe integer — above 2^53 the generation counter cannot advance), got ${maxGen}.`,
      { code: ErrorCode.InputOutOfRange, context: { maxGenerations: maxGen } },
    );
  }
  // The PRODUCT is the workload — each generation evaluates every member once — so bound it even when
  // both factors individually look tame (2026-08-23 review, P0: two multiplying counts must be
  // bounded together or neither bound means anything).
  if (NP * maxGen > MAX_DIFFERENTIAL_EVOLUTION_EVALUATIONS) {
    throw new InputError(
      `differentialEvolution: populationSize × maxGenerations must not exceed ${MAX_DIFFERENTIAL_EVOLUTION_EVALUATIONS.toLocaleString('en-US')} objective evaluations — each generation evaluates every member once, so the product is the run's total work (~seconds at the cap even for a trivial objective, measured ~37 ns/call; real objectives cost µs and dominate). Received ${NP} × ${maxGen} = ${(NP * maxGen).toLocaleString('en-US')}.\n  e.g. differentialEvolution((p) => p[0] ** 2, [[-5, 5]], { populationSize: 40, maxGenerations: 500 })`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          populationSize: NP,
          maxGenerations: maxGen,
          maxEvaluations: MAX_DIFFERENTIAL_EVOLUTION_EVALUATIONS,
        },
      },
    );
  }
  if (!(F > 0 && F <= 2)) {
    throw new InputError(
      `differentialEvolution: mutation (differential weight F) must be in (0, 2], got ${F}.`,
      { code: ErrorCode.InputOutOfRange, context: { mutation: F } },
    );
  }
  if (!(CR >= 0 && CR <= 1)) {
    throw new InputError(
      `differentialEvolution: crossover probability must be in [0, 1], got ${CR}.`,
      { code: ErrorCode.InputOutOfRange, context: { crossover: CR } },
    );
  }
  const randomNumberGenerator = mulberry32(seed);

  const clampReflect = (x: number, lo: number, hi: number): number => {
    if (hi === lo) return lo;
    let y = x;
    // Reflect into [lo, hi] (handles overshoot from the mutation step).
    const span = hi - lo;
    while (y < lo || y > hi) {
      if (y < lo) y = lo + (lo - y);
      if (y > hi) y = hi - (y - hi);
      if (!Number.isFinite(y)) y = lo + randomNumberGenerator.next() * span;
    }
    return y;
  };
  let evals = 0;
  const evalSafe = (x: number[]): number => {
    evals++;
    const v = objective(x);
    return Number.isFinite(v) ? v : Number.POSITIVE_INFINITY;
  };

  // Initialize.
  const pop: number[][] = Array.from({ length: NP }, () =>
    bounds.map(([lo, hi]) => lo + randomNumberGenerator.next() * (hi - lo)),
  );
  const fit = pop.map(evalSafe);
  let bestIdx = 0;
  for (let i = 1; i < NP; i++) if (fit[i]! < fit[bestIdx]!) bestIdx = i;

  let gen = 0;
  // Tracked explicitly rather than inferred from `gen < maxGen`: a run that meets the tolerance ON
  // the final generation increments `gen` to `maxGen` and would otherwise be reported as a budget
  // exhaustion — the one case where the honest answer ("converged") and the inferred one disagree.
  let converged = false;
  for (; gen < maxGen; gen++) {
    for (let i = 0; i < NP; i++) {
      // Pick three distinct indices ≠ i.
      let a = i;
      let b = i;
      let c = i;
      while (a === i) a = Math.floor(randomNumberGenerator.next() * NP);
      while (b === i || b === a) b = Math.floor(randomNumberGenerator.next() * NP);
      while (c === i || c === a || c === b) c = Math.floor(randomNumberGenerator.next() * NP);
      const xa = pop[a]!;
      const xb = pop[b]!;
      const xc = pop[c]!;
      const jRand = Math.floor(randomNumberGenerator.next() * dimensions);
      const trial = pop[i]!.slice();
      for (let j = 0; j < dimensions; j++) {
        if (randomNumberGenerator.next() < CR || j === jRand) {
          const [lo, hi] = bounds[j]!;
          trial[j] = clampReflect(xa[j]! + F * (xb[j]! - xc[j]!), lo, hi);
        }
      }
      const trialFit = evalSafe(trial);
      if (trialFit <= fit[i]!) {
        pop[i] = trial;
        fit[i] = trialFit;
        if (trialFit < fit[bestIdx]!) bestIdx = i;
      }
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of fit) {
      if (v < lo) lo = v;
      if (v > hi && Number.isFinite(v)) hi = v;
    }
    if (Number.isFinite(hi) && hi - lo < tolerance) {
      gen++;
      converged = true;
      break;
    }
  }

  return {
    argMin: pop[bestIdx]!.slice(),
    minimum: fit[bestIdx]!,
    converged,
    iterations: gen,
    evaluations: evals,
    seed,
    ...(converged ? {} : { reason: 'max_iterations' as const }),
  };
}
