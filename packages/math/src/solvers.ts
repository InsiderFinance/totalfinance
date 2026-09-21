/**
 * One-dimensional root solvers (spec §8.4).
 *
 * Design law #4: a solver NEVER returns a fake success. On non-convergence it returns
 * `converged: false` with a typed `reason`, and callers decide whether to throw or report. Every
 * result names the `method` used and carries the residual |f(value)| (and, for bracketing methods,
 * the final `bracket`).
 */

import {
  ErrorCode,
  InputError,
  ensureFinite,
  ensureFiniteWhenPresent,
  ensureKnownKeys,
  missingFieldError,
  requireArgumentObject,
} from '@totalfinance/core';
import { requireMathIterationBudgetWhenPresent } from './resource-validation.js';

export type SolverFailureReason =
  | 'no_sign_change'
  | 'non_finite_endpoint'
  | 'non_finite_iteration'
  | 'zero_derivative'
  | 'domain_error'
  | 'max_iterations'
  | 'stagnation';

export interface SolverResult {
  /** Best estimate of the root. May be `NaN` when bracketing failed. */
  value: number;
  /** Whether the method actually converged to the requested tolerance. */
  converged: boolean;
  /** Iterations performed. */
  iterations: number;
  /** Residual |f(value)| at the returned estimate, when finite. */
  residual?: number;
  /** Final bracket `[lo, hi]` for bracketing methods, when one was established. */
  bracket?: [number, number];
  /** Machine-readable failure reason when `converged` is `false`. */
  reason?: SolverFailureReason;
  /** The method that produced this result (e.g. `brent`, `newton`). */
  method: string;
}

export interface SolverOptions {
  /** Tolerance on the bracket width / x-step (alias for `stepTolerance`). */
  tolerance?: number;
  /** Absolute tolerance on the x-step / bracket width. */
  stepTolerance?: number;
  /** Absolute tolerance on |f|. When `f` falls below this, the solve converges early. */
  residualTolerance?: number;
  /** Maximum iterations before reporting non-convergence. */
  maximumIterations?: number;
}

export type ScalarFunction = (x: number) => number;

/** First through third derivatives at a point, for derivative-based solvers. */
export interface Derivatives {
  f: number;
  df: number;
  d2f?: number;
  d3f?: number;
}
export type FunctionWithDerivatives = (x: number) => Derivatives;

function xTolOf(options: SolverOptions, fallback: number): number {
  return options.stepTolerance ?? options.tolerance ?? fallback;
}

/** Normalize a bracket so `a <= b`. Reversed brackets are accepted, not rejected. */
function order(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a];
}

/**
 * Bisection on a sign-changing bracket `[a, b]`. Slow but unconditionally convergent when a sign
 * change exists; used as a robust fallback.
 */
/**
 * A solver must never RETURN on malformed input (the 3B.1b-1 IV-solver rule): `brent(f, 1,
 * undefined)` reported `converged: false, reason: 'no_sign_change'` — a plausible wrong answer
 * that reads as "no root in the bracket" when the truth is "you passed undefined". Shape throws
 * typed; a VALID problem that cannot converge still reports `converged: false` and fabricates
 * nothing. The options tables are COMPILER-CHECKED against the declared interfaces (the
 * statistics precedent for flat single-shape contracts) rather than generated: `brent` sits in
 * the black-scholes hot entrypoint's import graph, whose budget intent is "no schema/validator
 * code" — these guards are core helpers already in that graph, costing zero marginal bytes.
 */
const SOLVER_OPTION_KEYS = [
  'tolerance',
  'stepTolerance',
  'residualTolerance',
  'maximumIterations',
] as const satisfies readonly (keyof SolverOptions)[];

const BRACKET_EXPAND_OPTION_KEYS = [
  'factor',
  'maximumIterations',
] as const satisfies readonly (keyof BracketExpandOptions)[];

/** Derived from the REPORTED name and arity — a fixed example from a shared validator would
 * recommend `brent(...)` to every `bisection`/`newton` caller (the example-call inventory gate). */
function solverExampleOf(functionName: string, coordinateCount: number): string {
  return coordinateCount === 1
    ? `${functionName}((x) => x * x - 2, 1, { tolerance: 1e-10 })`
    : `${functionName}((x) => x * x - 2, 0, 2, { tolerance: 1e-10 })`;
}

function requireSolverInputs(
  functionName: string,
  objective: unknown,
  coordinates: ReadonlyArray<readonly [name: string, value: number]>,
  options: unknown,
  allowed: readonly string[] = SOLVER_OPTION_KEYS,
): void {
  if (typeof objective !== 'function') {
    throw new InputError(
      `${functionName}: objective must be a function. Received ${objective === null ? 'null' : typeof objective}.`,
      {
        code: ErrorCode.InputWrongType,
        context: {
          function: functionName,
          field: 'objective',
          received: objective === null ? 'null' : typeof objective,
        },
      },
    );
  }
  for (const [name, value] of coordinates) {
    // The four-code matrix, positionally: omitted coordinate → missing_field with the worked
    // example; wrong type → wrong_type (a string is not a "non-finite number" — bare ensureFinite
    // taught the useless code here once before); then NaN/Infinity with their own codes.
    if (value === undefined) {
      throw missingFieldError(
        functionName,
        name,
        solverExampleOf(functionName, coordinates.length),
      );
    }
    if (typeof value !== 'number') {
      throw new InputError(
        `${functionName}: ${name} must be a number. Received ${value === null ? 'null' : typeof value}.`,
        {
          code: ErrorCode.InputWrongType,
          context: {
            function: functionName,
            field: name,
            received: value === null ? 'null' : typeof value,
          },
        },
      );
    }
    ensureFinite(value, name, functionName);
  }
  if (options !== undefined) {
    requireArgumentObject(functionName, 'options', options);
    ensureKnownKeys(functionName, 'options', options as object, allowed);
    for (const key of allowed) {
      ensureFiniteWhenPresent(
        (options as Record<string, unknown>)[key],
        `options.${key}`,
        functionName,
      );
    }
    requireMathIterationBudgetWhenPresent(
      functionName,
      (options as Record<string, unknown>)['maximumIterations'],
    );
  }
}

export function bisection(
  objective: ScalarFunction,
  a0: number,
  b0: number,
  options: SolverOptions = {},
): SolverResult {
  requireSolverInputs(
    'bisection',
    objective,
    [
      ['a0', a0],
      ['b0', b0],
    ],
    options,
  );
  const [a, b] = order(a0, b0);
  const stepTolerance = xTolOf(options, 1e-12);
  const residualTolerance = options.residualTolerance ?? 0;
  const maximumIterations = options.maximumIterations ?? 200;
  const fa = objective(a);
  const fb = objective(b);
  if (!Number.isFinite(fa) || !Number.isFinite(fb)) {
    return {
      value: NaN,
      converged: false,
      iterations: 0,
      reason: 'non_finite_endpoint',
      method: 'bisection',
    };
  }
  if (fa === 0)
    return {
      value: a,
      converged: true,
      iterations: 0,
      residual: 0,
      bracket: [a, b],
      method: 'bisection',
    };
  if (fb === 0)
    return {
      value: b,
      converged: true,
      iterations: 0,
      residual: 0,
      bracket: [a, b],
      method: 'bisection',
    };
  if (fa * fb > 0)
    return {
      value: NaN,
      converged: false,
      iterations: 0,
      bracket: [a, b],
      reason: 'no_sign_change',
      method: 'bisection',
    };

  let lo = a;
  let hi = b;
  let flo = fa;
  for (let i = 1; i <= maximumIterations; i++) {
    const mid = 0.5 * (lo + hi);
    const fm = objective(mid);
    if (!Number.isFinite(fm))
      return {
        value: NaN,
        converged: false,
        iterations: i,
        reason: 'non_finite_iteration',
        method: 'bisection',
      };
    if (fm === 0 || Math.abs(fm) <= residualTolerance || (hi - lo) / 2 < stepTolerance) {
      return {
        value: mid,
        converged: true,
        iterations: i,
        residual: Math.abs(fm),
        bracket: [lo, hi],
        method: 'bisection',
      };
    }
    if (flo * fm < 0) {
      hi = mid;
    } else {
      lo = mid;
      flo = fm;
    }
  }
  const mid = 0.5 * (lo + hi);
  return {
    value: mid,
    converged: false,
    iterations: maximumIterations,
    residual: Math.abs(objective(mid)),
    bracket: [lo, hi],
    reason: 'max_iterations',
    method: 'bisection',
  };
}

/**
 * Brent's method: inverse-quadratic / secant interpolation with a bisection safeguard. The robust
 * default root solver.
 */
export function brent(
  objective: ScalarFunction,
  a0: number,
  b0: number,
  options: SolverOptions = {},
): SolverResult {
  requireSolverInputs(
    'brent',
    objective,
    [
      ['a0', a0],
      ['b0', b0],
    ],
    options,
  );
  let [a, b] = order(a0, b0);
  const stepTolerance = xTolOf(options, 1e-12);
  const residualTolerance = options.residualTolerance ?? 0;
  const maximumIterations = options.maximumIterations ?? 200;

  let fa = objective(a);
  let fb = objective(b);
  if (!Number.isFinite(fa) || !Number.isFinite(fb)) {
    return {
      value: NaN,
      converged: false,
      iterations: 0,
      reason: 'non_finite_endpoint',
      method: 'brent',
    };
  }
  if (fa === 0)
    return {
      value: a,
      converged: true,
      iterations: 0,
      residual: 0,
      bracket: [a, b],
      method: 'brent',
    };
  if (fb === 0)
    return {
      value: b,
      converged: true,
      iterations: 0,
      residual: 0,
      bracket: [a, b],
      method: 'brent',
    };
  if (fa * fb > 0)
    return {
      value: NaN,
      converged: false,
      iterations: 0,
      bracket: [a, b],
      reason: 'no_sign_change',
      method: 'brent',
    };

  let c = a;
  let fc = fa;
  let d = b - a;
  let e = d;

  for (let iter = 1; iter <= maximumIterations; iter++) {
    if (fb * fc > 0) {
      c = a;
      fc = fa;
      d = b - a;
      e = d;
    }
    if (Math.abs(fc) < Math.abs(fb)) {
      a = b;
      b = c;
      c = a;
      fa = fb;
      fb = fc;
      fc = fa;
    }
    const tol1 = 2 * Number.EPSILON * Math.abs(b) + 0.5 * stepTolerance;
    const xm = 0.5 * (c - b);
    if (Math.abs(xm) <= tol1 || fb === 0 || Math.abs(fb) <= residualTolerance) {
      return {
        value: b,
        converged: true,
        iterations: iter,
        residual: Math.abs(fb),
        bracket: [Math.min(b, c), Math.max(b, c)],
        method: 'brent',
      };
    }
    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      const sVal = fb / fa;
      let p: number;
      let q: number;
      if (a === c) {
        p = 2 * xm * sVal;
        q = 1 - sVal;
      } else {
        const qa = fa / fc;
        const r = fb / fc;
        p = sVal * (2 * xm * qa * (qa - r) - (b - a) * (r - 1));
        q = (qa - 1) * (r - 1) * (sVal - 1);
      }
      if (p > 0) q = -q;
      p = Math.abs(p);
      const min1 = 3 * xm * q - Math.abs(tol1 * q);
      const min2 = Math.abs(e * q);
      if (2 * p < Math.min(min1, min2)) {
        e = d;
        d = p / q;
      } else {
        d = xm;
        e = d;
      }
    } else {
      d = xm;
      e = d;
    }
    a = b;
    fa = fb;
    b += Math.abs(d) > tol1 ? d : xm > 0 ? tol1 : -tol1;
    fb = objective(b);
    if (!Number.isFinite(fb))
      return {
        value: NaN,
        converged: false,
        iterations: iter,
        reason: 'non_finite_iteration',
        method: 'brent',
      };
  }
  return {
    value: b,
    converged: false,
    iterations: maximumIterations,
    residual: Math.abs(fb),
    bracket: [Math.min(b, c), Math.max(b, c)],
    reason: 'max_iterations',
    method: 'brent',
  };
}

/** Ridder's method: exponential interpolation on a sign-changing bracket. Often beats bisection. */
export function ridder(
  objective: ScalarFunction,
  a0: number,
  b0: number,
  options: SolverOptions = {},
): SolverResult {
  requireSolverInputs(
    'ridder',
    objective,
    [
      ['a0', a0],
      ['b0', b0],
    ],
    options,
  );
  let [xlo, xhi] = order(a0, b0);
  const stepTolerance = xTolOf(options, 1e-12);
  const residualTolerance = options.residualTolerance ?? 0;
  const maximumIterations = options.maximumIterations ?? 100;
  let flo = objective(xlo);
  let fhi = objective(xhi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi)) {
    return {
      value: NaN,
      converged: false,
      iterations: 0,
      reason: 'non_finite_endpoint',
      method: 'ridder',
    };
  }
  if (flo === 0)
    return {
      value: xlo,
      converged: true,
      iterations: 0,
      residual: 0,
      bracket: [xlo, xhi],
      method: 'ridder',
    };
  if (fhi === 0)
    return {
      value: xhi,
      converged: true,
      iterations: 0,
      residual: 0,
      bracket: [xlo, xhi],
      method: 'ridder',
    };
  if (flo * fhi > 0)
    return {
      value: NaN,
      converged: false,
      iterations: 0,
      bracket: [xlo, xhi],
      reason: 'no_sign_change',
      method: 'ridder',
    };

  let result = NaN;
  for (let iter = 1; iter <= maximumIterations; iter++) {
    const xm = 0.5 * (xlo + xhi);
    const fm = objective(xm);
    const s = Math.sqrt(fm * fm - flo * fhi);
    if (s === 0)
      return {
        value: xm,
        converged: true,
        iterations: iter,
        residual: Math.abs(fm),
        bracket: [xlo, xhi],
        method: 'ridder',
      };
    const dx = ((xm - xlo) * fm) / s;
    const xnew = flo - fhi < 0 ? xm - dx : xm + dx;
    const fnew = objective(xnew);
    if (!Number.isFinite(fnew))
      return {
        value: NaN,
        converged: false,
        iterations: iter,
        reason: 'non_finite_iteration',
        method: 'ridder',
      };
    if (Math.abs(fnew) <= residualTolerance)
      return {
        value: xnew,
        converged: true,
        iterations: iter,
        residual: Math.abs(fnew),
        bracket: [xlo, xhi],
        method: 'ridder',
      };
    if (!Number.isNaN(result) && Math.abs(xnew - result) <= stepTolerance) {
      return {
        value: xnew,
        converged: true,
        iterations: iter,
        residual: Math.abs(fnew),
        bracket: [xlo, xhi],
        method: 'ridder',
      };
    }
    result = xnew;
    // re-bracket
    if (Math.sign(fm) !== Math.sign(fnew)) {
      xlo = xm;
      flo = fm;
      xhi = xnew;
      fhi = fnew;
    } else if (Math.sign(flo) !== Math.sign(fnew)) {
      xhi = xnew;
      fhi = fnew;
    } else {
      xlo = xnew;
      flo = fnew;
    }
    if (Math.abs(xhi - xlo) <= stepTolerance)
      return {
        value: result,
        converged: true,
        iterations: iter,
        residual: Math.abs(fnew),
        bracket: [xlo, xhi],
        method: 'ridder',
      };
  }
  return {
    value: result,
    converged: false,
    iterations: maximumIterations,
    residual: Math.abs(objective(result)),
    bracket: [xlo, xhi],
    reason: 'max_iterations',
    method: 'ridder',
  };
}

/** Secant method from two starting points. Fast but not bracketed. */
export function secant(
  objective: ScalarFunction,
  x0: number,
  x1: number,
  options: SolverOptions = {},
): SolverResult {
  requireSolverInputs(
    'secant',
    objective,
    [
      ['x0', x0],
      ['x1', x1],
    ],
    options,
  );
  const stepTolerance = xTolOf(options, 1e-12);
  const residualTolerance = options.residualTolerance ?? 0;
  const maximumIterations = options.maximumIterations ?? 100;
  let a = x0;
  let b = x1;
  let fa = objective(a);
  let fb = objective(b);
  for (let i = 1; i <= maximumIterations; i++) {
    if (!Number.isFinite(fa) || !Number.isFinite(fb)) {
      return {
        value: NaN,
        converged: false,
        iterations: i,
        reason: 'non_finite_iteration',
        method: 'secant',
      };
    }
    if (Math.abs(fb) <= residualTolerance)
      return { value: b, converged: true, iterations: i, residual: Math.abs(fb), method: 'secant' };
    const denom = fb - fa;
    if (denom === 0)
      return {
        value: b,
        converged: false,
        iterations: i,
        reason: 'zero_derivative',
        method: 'secant',
      };
    const x = b - (fb * (b - a)) / denom;
    if (Math.abs(x - b) <= stepTolerance * (1 + Math.abs(x))) {
      return {
        value: x,
        converged: true,
        iterations: i,
        residual: Math.abs(objective(x)),
        method: 'secant',
      };
    }
    a = b;
    fa = fb;
    b = x;
    fb = objective(b);
  }
  return {
    value: b,
    converged: false,
    iterations: maximumIterations,
    residual: Math.abs(fb),
    reason: 'max_iterations',
    method: 'secant',
  };
}

function newtonLike(
  objective: FunctionWithDerivatives,
  x0: number,
  options: SolverOptions,
  defaultMaxIter: number,
  method: string,
  step: (d: Required<Pick<Derivatives, 'f' | 'df'>> & Derivatives) => number,
): SolverResult {
  const stepTolerance = xTolOf(options, 1e-12);
  const residualTolerance = options.residualTolerance ?? 0;
  const maximumIterations = options.maximumIterations ?? defaultMaxIter;
  let x = x0;
  for (let i = 1; i <= maximumIterations; i++) {
    const d = objective(x);
    if (!Number.isFinite(d.f) || !Number.isFinite(d.df)) {
      return {
        value: NaN,
        converged: false,
        iterations: i,
        reason: 'non_finite_iteration',
        method,
      };
    }
    if (Math.abs(d.f) <= residualTolerance)
      return { value: x, converged: true, iterations: i, residual: Math.abs(d.f), method };
    if (d.df === 0)
      return { value: x, converged: false, iterations: i, reason: 'zero_derivative', method };
    const dx = step(d as Required<Pick<Derivatives, 'f' | 'df'>> & Derivatives);
    if (!Number.isFinite(dx))
      return {
        value: NaN,
        converged: false,
        iterations: i,
        reason: 'non_finite_iteration',
        method,
      };
    x -= dx;
    if (Math.abs(dx) <= stepTolerance * (1 + Math.abs(x))) {
      return {
        value: x,
        converged: true,
        iterations: i,
        residual: Math.abs(objective(x).f),
        method,
      };
    }
  }
  return {
    value: x,
    converged: false,
    iterations: maximumIterations,
    residual: Math.abs(objective(x).f),
    reason: 'max_iterations',
    method,
  };
}

/** Newton–Raphson. `objective` returns `{ f, df }`. */
export function newton(
  objective: FunctionWithDerivatives,
  x0: number,
  options: SolverOptions = {},
): SolverResult {
  requireSolverInputs('newton', objective, [['x0', x0]], options);
  return newtonLike(objective, x0, options, 100, 'newton', (d) => d.f / d.df);
}

/** Halley's method (cubic convergence). `objective` returns `{ f, df, d2f }`. */
export function halley(
  objective: FunctionWithDerivatives,
  x0: number,
  options: SolverOptions = {},
): SolverResult {
  requireSolverInputs('halley', objective, [['x0', x0]], options);
  return newtonLike(objective, x0, options, 60, 'halley', (d) => {
    const d2f = d.d2f ?? 0;
    const denom = 2 * d.df * d.df - d.f * d2f;
    return denom === 0 ? Infinity : (2 * d.f * d.df) / denom;
  });
}

/** Householder's method of order 3 (quartic convergence). `objective` returns `{ f, df, d2f, d3f }`. */
export function householder(
  objective: FunctionWithDerivatives,
  x0: number,
  options: SolverOptions = {},
): SolverResult {
  requireSolverInputs('householder', objective, [['x0', x0]], options);
  return newtonLike(objective, x0, options, 40, 'householder', (d) => {
    const d2f = d.d2f ?? 0;
    const d3f = d.d3f ?? 0;
    const f = d.f;
    const f1 = d.df;
    const num = 6 * f * f1 * f1 - 3 * f * f * d2f;
    const den = 6 * f1 * f1 * f1 - 6 * f * f1 * d2f + f * f * d3f;
    return den === 0 ? Infinity : num / den;
  });
}

export interface BracketExpandOptions {
  /** Growth factor per step (default 1.6). */
  factor?: number;
  /** Maximum expansion steps (default 60). */
  maximumIterations?: number;
}

export interface Bracket {
  lowerBound: number;
  upperBound: number;
  objectiveAtLowerBound: number;
  objectiveAtUpperBound: number;
  found: boolean;
  /** Expansion steps taken (so callers like findRoot can report a truthful total iteration count). */
  iterations: number;
}

/** Expand an initial interval outward until it brackets a sign change. */
export function bracketExpand(
  objective: ScalarFunction,
  a0: number,
  b0: number,
  options: BracketExpandOptions = {},
): Bracket {
  requireSolverInputs(
    'bracketExpand',
    objective,
    [
      ['a0', a0],
      ['b0', b0],
    ],
    options,
    BRACKET_EXPAND_OPTION_KEYS,
  );
  const factor = options.factor ?? 1.6;
  const maximumIterations = options.maximumIterations ?? 60;
  let a = a0;
  let b = b0;
  if (a === b) b = a + 1;
  let fa = objective(a);
  let fb = objective(b);
  for (let i = 0; i < maximumIterations; i++) {
    if (Number.isFinite(fa) && Number.isFinite(fb) && fa * fb < 0) {
      return {
        lowerBound: a,
        upperBound: b,
        objectiveAtLowerBound: fa,
        objectiveAtUpperBound: fb,
        found: true,
        iterations: i,
      };
    }
    if (Math.abs(fa) < Math.abs(fb)) {
      a += factor * (a - b);
      fa = objective(a);
    } else {
      b += factor * (b - a);
      fb = objective(b);
    }
  }
  return {
    lowerBound: a,
    upperBound: b,
    objectiveAtLowerBound: fa,
    objectiveAtUpperBound: fb,
    found: false,
    iterations: maximumIterations,
  };
}

/**
 * Safe hybrid solver: expand a bracket if needed, then run Brent. Kept as a named entrypoint so
 * callers express intent ("give me the robust default").
 */
export function findRoot(
  objective: ScalarFunction,
  lowerBound: number,
  upperBound: number,
  options?: SolverOptions,
): SolverResult {
  requireSolverInputs(
    'findRoot',
    objective,
    [
      ['lowerBound', lowerBound],
      ['upperBound', upperBound],
    ],
    options,
  );
  const first = brent(objective, lowerBound, upperBound, options);
  if (first.converged || first.reason !== 'no_sign_change') return first; // Brent alone sufficed
  // The initial bracket didn't straddle a root: expand it, re-solve, and report the COMBINED method
  // and iteration count (the old code hid the expansion work and mislabelled the method as 'brent').
  const expanded = bracketExpand(objective, lowerBound, upperBound);
  if (!expanded.found) {
    return {
      value: NaN,
      converged: false,
      iterations: first.iterations + expanded.iterations,
      reason: 'no_sign_change',
      method: 'bracket+brent',
    };
  }
  const second = brent(objective, expanded.lowerBound, expanded.upperBound, options);
  return {
    ...second,
    iterations: first.iterations + expanded.iterations + second.iterations,
    method: 'bracket+brent',
  };
}

export interface RootProblem {
  objective: ScalarFunction;
  lowerBound: number;
  upperBound: number;
}

/** Solve a batch of bracketed root problems, returning one diagnostic-carrying result per row. */
export function solveAll(problems: RootProblem[], options?: SolverOptions): SolverResult[] {
  if (options !== undefined) {
    requireArgumentObject('solveAll', 'options', options);
    ensureKnownKeys('solveAll', 'options', options, SOLVER_OPTION_KEYS);
    for (const key of SOLVER_OPTION_KEYS) {
      ensureFiniteWhenPresent(options[key], `options.${key}`, 'solveAll');
    }
    requireMathIterationBudgetWhenPresent('solveAll', options.maximumIterations);
  }
  return problems.map((problem) =>
    brent(problem.objective, problem.lowerBound, problem.upperBound, options),
  );
}
