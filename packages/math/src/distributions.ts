/**
 * Continuous statistical distributions (spec §8.5a): Student's t, chi-square, and the gamma family.
 *
 * The workhorses are two special functions, implemented once and shared:
 *   - the **regularized incomplete gamma** `P(a, x)` (lower) via the Numerical-Recipes series
 *     expansion for `x < a + 1`, the Lentz continued fraction for `Q(a, x)` otherwise, and — for a
 *     LARGE shape (`a ≥ 150`, i.e. `chiSquare` past ~300 degrees of freedom) — Gauss–Legendre
 *     quadrature over the peak of the integrand, because neither iteration converges in a bounded
 *     number of terms once `a` is large. This drives `chiSquare` and `gamma`.
 *   - the **regularized incomplete beta** `Iₓ(a, b)` via a Lentz continued fraction — this drives
 *     Student's `t` CDF through the standard identity `F_t(x) = 1 − ½·I_{ν/(ν+x²)}(ν/2, ½)` for `x > 0`.
 *
 * Both rely on {@link lgamma} (Lanczos, g = 7), accurate to ~1e-15 over the domain. Quantile (`inv`)
 * functions invert the monotone CDF with a bracketed {@link brent} solve — no fake successes: the CDF
 * is exact to solver tolerance, so the returned quantile is too.
 *
 * Every function is a pure deterministic mapping. Invalid arguments throw `InputError` with a stable
 * `code` (mirroring the rest of `@totalfinance/math`).
 */

import { ConvergenceError, ErrorCode, InputError } from '@totalfinance/core';
import { gaussLegendreNodes } from './integration.js';
import { normalInverseCdf } from './normal.js';
import { brent, bracketExpand } from './solvers.js';

// ───────────────────────── numerical constants ─────────────────────────

/** Maximum iterations for the series / continued-fraction expansions. */
const ITMAX = 400;
/**
 * Shape above which `P(a, x)` is evaluated by quadrature instead of the series / continued fraction.
 *
 * The series needs on the order of `a + c·√a` terms near the peak, so a fixed iteration budget stops
 * being a budget and starts being a wrong answer: at `a = 5·10⁵` (χ² with 10⁶ degrees of freedom) the
 * 400-term sum had reached 0.215 when the true `P(a, a)` is 0.500 — and it was RETURNED, not
 * reported. Numerical Recipes switches to quadrature at `a = 100` for exactly this reason; 150 keeps
 * the series comfortably inside its budget (~200 terms at the boundary) while overlapping the
 * quadrature's accurate range, so the two branches agree to ~1e-14 where they meet.
 */
const LARGE_SHAPE = 150;
/**
 * Quadrature order for the large-shape branch. Numerical Recipes uses 18 points; measured against a
 * fully converged (un-capped) series, 18 leaves ~1e-11 of error at the peak `x ≈ a` for `a` in the
 * hundreds-to-thousands, and 24 takes that to ~1e-13 for six more `exp` calls. Above `a ≈ 10⁶` the
 * accuracy floor is double precision itself — the exponent `−x + a·ln x − lnΓ(a)` cancels to ~1e-8
 * relative there, for the reference implementation exactly as much as for this one — so more points
 * buy nothing.
 */
const GAUSS_LEGENDRE_ORDER = 24;
/** Relative convergence tolerance for the special-function iterations. */
const EPS = 1e-15;
/** A number near the smallest representable positive double, guarding against division by zero. */
const FPMIN = 1e-300;
const LOG_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);

// ───────────────────────── log-gamma (Lanczos g = 7) ─────────────────────────

const LANCZOS_G = 7;
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/**
 * Natural log of the gamma function, `ln Γ(x)`, via the Lanczos approximation (g = 7, 9 coefficients),
 * accurate to ~1e-15 for `x > 0`. Uses the reflection formula `Γ(x)Γ(1−x) = π / sin(πx)` for `x < 0.5`.
 */
export function lgamma(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x < 0.5) {
    // Reflection: ln Γ(x) = ln(π / sin(πx)) − ln Γ(1 − x).
    const s = Math.sin(Math.PI * x);
    return Math.log(Math.PI / Math.abs(s)) - lgamma(1 - x);
  }
  const z = x - 1;
  let a = LANCZOS[0]!;
  const t = z + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_G + 2; i++) a += LANCZOS[i]! / (z + i);
  return LOG_SQRT_2PI + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

// ───────────────────────── regularized incomplete gamma ─────────────────────────

/**
 * The iteration budget ran out before the expansion converged. NEVER returned as a value: an
 * unconverged partial sum looks exactly like a converged one, and a caller comparing it to 0.05
 * cannot tell that it is off by half. Design law #4 — report, don't fabricate.
 */
function iterationLimit(functionName: string, a: number, x: number): ConvergenceError {
  return new ConvergenceError(
    `${functionName}: the expansion for the incomplete gamma P(a=${a}, x=${x}) did not converge within ${ITMAX} terms; the partial sum is NOT a usable probability.`,
    {
      code: ErrorCode.MathIterationLimit,
      context: { a, x, maximumIterations: ITMAX },
    },
  );
}

/** Lower regularized incomplete gamma `P(a, x) = γ(a, x) / Γ(a)` via a power series (best for `x < a+1`). */
function gammaSeries(a: number, x: number): number {
  let ap = a;
  let del = 1 / a;
  let sum = del;
  let converged = false;
  for (let n = 0; n < ITMAX; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) {
      converged = true;
      break;
    }
  }
  // Backstop only: the large-shape quadrature branch below takes every case the series cannot
  // finish, so reaching this throw means an input escaped that routing — loud beats silent.
  if (!converged) throw iterationLimit('gammaSeries', a, x);
  return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
}

/** Upper regularized incomplete gamma `Q(a, x) = Γ(a, x) / Γ(a)` via the Lentz continued fraction (`x ≥ a+1`). */
function gammaContinuedFraction(a: number, x: number): number {
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  let converged = false;
  for (let i = 1; i <= ITMAX; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) {
      converged = true;
      break;
    }
  }
  if (!converged) throw iterationLimit('gammaContinuedFraction', a, x);
  return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}

/** The Gauss–Legendre rule mapped to `[0, 1]`, built once on the first large-shape evaluation. */
let unitGaussLegendre: { nodes: number[]; weights: number[] } | null = null;

function unitRule(): { nodes: number[]; weights: number[] } {
  if (unitGaussLegendre === null) {
    const { nodes, weights } = gaussLegendreNodes(GAUSS_LEGENDRE_ORDER);
    unitGaussLegendre = {
      nodes: nodes.map((t) => 0.5 * (t + 1)),
      weights: weights.map((w) => 0.5 * w),
    };
  }
  return unitGaussLegendre;
}

/**
 * `ln[ (a₁^a₁ · e^(−a₁)) / Γ(a₁ + 1) ]`, the log of the integrand's peak scale, by the Stirling
 * series — `−[½·ln(2π·a₁) + 1/(12a₁) − 1/(360a₁³) + 1/(1260a₁⁵)]`.
 *
 * Same reason as the `log1p` in the integrand: written literally as `a₁·(ln a₁ − 1) − lnΓ(a)` it
 * subtracts two numbers that are equal to ~12 significant figures (2.7e13 apiece at `a = 10¹²`), so
 * their 1e-16 relative errors survive as ~1e-3 ABSOLUTE error in an exponent. The two cancellations
 * are independent and comparable in size, so fixing either alone changes nothing measurable and
 * fixing both moves `P(10¹², 10¹²)` from 1.1e-4 of error to 9e-12. Only ever called with
 * `a₁ ≥ 149`, where the truncated series is good to ~4e-19.
 */
function logPeakScale(a1: number): number {
  const inv = 1 / a1;
  return -(
    0.5 * Math.log(2 * Math.PI * a1) +
    inv * (1 / 12 - inv * inv * (1 / 360 - (inv * inv) / 1260))
  );
}

/**
 * Lower regularized incomplete gamma `P(a, x)` for a LARGE shape, by direct Gauss–Legendre
 * quadrature of the integrand over the region where it is not negligible (the `gammpapprox` of
 * Numerical Recipes §6.2).
 *
 * For large `a` the integrand `t^(a−1)e^(−t)/Γ(a)` is a narrow bump of width `O(√a)` centred on
 * `a − 1`, so integrating outward from `x` to a cut-off `≈ 11.5·√(a−1)` past the peak captures
 * everything to machine precision in 18 evaluations — no iteration budget to exhaust. The integrand
 * is evaluated in log form so `t^(a−1)` never overflows.
 */
function gammaQuadrature(a: number, x: number): number {
  const a1 = a - 1;
  const sqrta1 = Math.sqrt(a1);
  // Integrate away from the peak: upward when x is past it, downward when x is below it.
  const cut =
    x > a1
      ? Math.max(a1 + 11.5 * sqrta1, x + 6 * sqrta1)
      : Math.max(0, Math.min(a1 - 7.5 * sqrta1, x - 5 * sqrta1));
  const { nodes, weights } = unitRule();
  let sum = 0;
  for (let i = 0; i < nodes.length; i++) {
    const t = x + (cut - x) * nodes[i]!;
    if (t <= 0) continue; // only reachable when cut === 0, where the integrand is 0 anyway
    // Written as a1·(ln1p(u) − u) with u = (t − a1)/a1, NOT as −(t − a1) + a1·(ln t − ln a1).
    // Algebraically identical; numerically not. `ln t − ln a1` differs in the last few digits of two
    // numbers of size ~ln a, and that ~1e-16 absolute error is then MULTIPLIED BY a1.
    const u = (t - a1) / a1;
    sum += weights[i]! * Math.exp(a1 * (Math.log1p(u) - u));
  }
  const tail = sum * (cut - x) * Math.exp(logPeakScale(a1));
  // `tail` is Q(a, x) when integrating upward (positive width) and −P(a, x) when integrating
  // downward; both directions return P. The branch is taken on the DIRECTION, not on `sign(tail)`
  // as Numerical Recipes writes it: far into the upper tail `Q` underflows to exactly 0, `0 > 0` is
  // false, and the sign test then answers `−0` for a probability that is 1.
  return x > a1 ? 1 - tail : -tail;
}

/** Lower regularized incomplete gamma `P(a, x)`, `a > 0`, `x ≥ 0`. Ranges monotonically from 0 to 1. */
function lowerRegGamma(a: number, x: number): number {
  if (x <= 0) return 0;
  // `P(a, ∞) = 1` is a limit, not something to iterate towards: fed to the continued fraction it
  // produces `exp(−∞ + ∞)` = NaN and can never meet the convergence test. (Matches `normalCdf(∞) = 1`.)
  if (x === Infinity) return 1;
  if (a >= LARGE_SHAPE) return gammaQuadrature(a, x);
  if (x < a + 1) return gammaSeries(a, x);
  return 1 - gammaContinuedFraction(a, x);
}

// ───────────────────────── regularized incomplete beta ─────────────────────────

/** Lentz continued fraction for the incomplete beta (the `betacf` of Numerical Recipes). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= ITMAX; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta `Iₓ(a, b)`, `a,b > 0`, `x ∈ [0, 1]`. Monotone from 0 to 1. */
function regIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lgamma(a + b) - lgamma(a) - lgamma(b);
  const front = Math.exp(lbeta + a * Math.log(x) + b * Math.log(1 - x));
  // Choose the tail with faster convergence; the symmetry Iₓ(a,b) = 1 − I_{1−x}(b,a) supplies the rest.
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

// ───────────────────────── shared validation + quantile inversion ─────────────────────────

function requireFinite(value: number, name: string, functionName: string): void {
  if (!Number.isFinite(value)) {
    throw new InputError(`${functionName}: ${name} must be a finite number, got ${value}.`, {
      code: ErrorCode.InputNotFinite,
      context: { [name]: value },
    });
  }
}

function requirePositive(value: number, name: string, functionName: string): void {
  requireFinite(value, name, functionName);
  if (value <= 0) {
    throw new InputError(`${functionName}: ${name} must be positive, got ${value}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { [name]: value },
    });
  }
}

function requireProbability(p: number, functionName: string): void {
  if (Number.isNaN(p) || p < 0 || p > 1) {
    throw new InputError(`${functionName}: probability must be in [0, 1], got ${p}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { p },
    });
  }
}

/**
 * Invert a strictly increasing CDF defined on all reals via a bracketed {@link brent} solve. `guess`
 * seeds an outward bracket expansion, so heavy-tailed targets are handled without a hand-tuned window.
 */
function invertRealCdf(cdf: (x: number) => number, p: number, guess: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const f = (x: number): number => cdf(x) - p;
  const g = Number.isFinite(guess) ? guess : 0;
  const bracket = bracketExpand(f, g - 1, g + 1, { factor: 1.6, maximumIterations: 100 });
  if (!bracket.found) return NaN;
  const r = brent(f, bracket.lowerBound, bracket.upperBound, {
    stepTolerance: 1e-13,
    maximumIterations: 300,
  });
  return r.value;
}

/** Below this the linear-space solve has hit its ABSOLUTE step tolerance and carries no digits. */
const TAIL_QUANTILE_FLOOR = 1e-8;
/** `Math.exp` underflows to exactly 0 below this exponent, so the log-space bracket bottoms out here. */
const LOG_UNDERFLOW = -750;

/**
 * Invert a strictly increasing CDF supported on `(0, ∞)`. Doubles an upper bound until it straddles
 * `p`, then solves on `[0, hi]` with {@link brent}.
 *
 * Deep in the lower tail the answer is smaller than any ABSOLUTE step tolerance — the χ²₁ quantile at
 * `p = 1e-8` is 1.57e-16 — so a linear-space solve legitimately reports "converged" at 0 and the
 * caller receives a quantile with no significant digits at all. When the root lands at or below
 * {@link TAIL_QUANTILE_FLOOR} the solve is repeated in LOG space (`u = ln x`), where the same step
 * tolerance is a RELATIVE one and the tail resolves to full precision.
 */
function invertPositiveCdf(cdf: (x: number) => number, p: number, guess: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return Infinity;
  let hi = Math.max(guess, 1e-6);
  let guard = 0;
  while (cdf(hi) < p && guard < 300) {
    hi *= 2;
    guard += 1;
  }
  const r = brent((x) => cdf(x) - p, 0, hi, { stepTolerance: 1e-12, maximumIterations: 400 });
  if (r.value > TAIL_QUANTILE_FLOOR) return r.value;

  // Log-space re-solve. `hi` already straddles p from above, so ln(hi) is a valid upper bound; walk
  // the lower bound down (doubling the exponent) until the CDF drops below p or exp underflows to 0.
  const logObjective = (u: number): number => cdf(Math.exp(u)) - p;
  const upper = Math.log(hi);
  let lower = Math.min(Math.log(TAIL_QUANTILE_FLOOR), upper - 1);
  for (let i = 0; i < 64 && lower > LOG_UNDERFLOW && logObjective(lower) > 0; i++) {
    lower = Math.max(2 * lower, LOG_UNDERFLOW);
  }
  const logRoot = brent(logObjective, lower, upper, {
    stepTolerance: 1e-13,
    maximumIterations: 400,
  });
  // No fabrication: if the tail solve fails (the true quantile underflows the double range), keep
  // the linear-space answer rather than inventing one.
  return logRoot.converged ? Math.exp(logRoot.value) : r.value;
}

// ───────────────────────── Student's t ─────────────────────────

/** Student's t-distribution with `df` degrees of freedom (`df > 0`, need not be an integer). */
export const studentT = {
  /** Probability density `f(x; ν)`. */
  pdf(x: number, degreesOfFreedom: number): number {
    requireFinite(x, 'x', 'studentT.pdf');
    requirePositive(degreesOfFreedom, 'degreesOfFreedom', 'studentT.pdf');
    const lp =
      lgamma((degreesOfFreedom + 1) / 2) -
      lgamma(degreesOfFreedom / 2) -
      0.5 * Math.log(degreesOfFreedom * Math.PI) -
      ((degreesOfFreedom + 1) / 2) * Math.log1p((x * x) / degreesOfFreedom);
    return Math.exp(lp);
  },

  /**
   * Cumulative distribution `F(x; ν)`. Uses `F(x) = 1 − ½·I_{ν/(ν+x²)}(ν/2, ½)` for `x > 0` and the
   * mirror image for `x < 0`; `F(0) = ½` exactly by symmetry.
   */
  cdf(x: number, degreesOfFreedom: number): number {
    requireFinite(x, 'x', 'studentT.cdf');
    requirePositive(degreesOfFreedom, 'degreesOfFreedom', 'studentT.cdf');
    if (x === 0) return 0.5;
    const xt = degreesOfFreedom / (degreesOfFreedom + x * x);
    const ib = regIncompleteBeta(degreesOfFreedom / 2, 0.5, xt);
    return x > 0 ? 1 - 0.5 * ib : 0.5 * ib;
  },

  /** Survival function `1 − F(x; ν)` (equivalently `F(−x; ν)` by symmetry). */
  survivalFunction(x: number, degreesOfFreedom: number): number {
    return this.cdf(-x, degreesOfFreedom);
  },

  /** Quantile (inverse CDF). Returns `±Infinity` at the boundaries `p = 0` / `p = 1`. */
  inverseCdf(probability: number, degreesOfFreedom: number): number {
    requireProbability(probability, 'studentT.inverseCdf');
    requirePositive(degreesOfFreedom, 'degreesOfFreedom', 'studentT.inverseCdf');
    if (probability === 0.5) return 0;
    // Seed from the normal quantile; brent's outward expansion covers the heavier t tails.
    return invertRealCdf(
      (x) => this.cdf(x, degreesOfFreedom),
      probability,
      normalInverseCdf(probability),
    );
  },
} as const;

// ───────────────────────── chi-square ─────────────────────────

/** The chi-square distribution with `df` degrees of freedom (`df > 0`) — gamma(k = df/2, θ = 2). */
export const chiSquare = {
  /**
   * Cumulative distribution `F(x; k) = P(k/2, x/2)`. For `k = 2` this collapses to the closed form
   * `1 − e^(−x/2)`.
   */
  cdf(x: number, degreesOfFreedom: number): number {
    requirePositive(degreesOfFreedom, 'degreesOfFreedom', 'chiSquare.cdf');
    if (Number.isNaN(x)) return NaN;
    if (x <= 0) return 0;
    return lowerRegGamma(degreesOfFreedom / 2, x / 2);
  },

  /** Quantile (inverse CDF) on `(0, ∞)`. */
  inverseCdf(probability: number, degreesOfFreedom: number): number {
    requireProbability(probability, 'chiSquare.inverseCdf');
    requirePositive(degreesOfFreedom, 'degreesOfFreedom', 'chiSquare.inverseCdf');
    // Mean of χ²(df) is df — a natural scale for the bracket search.
    return invertPositiveCdf((x) => this.cdf(x, degreesOfFreedom), probability, degreesOfFreedom);
  },
} as const;

// ───────────────────────── gamma ─────────────────────────

/** The gamma distribution with shape `k > 0` and scale `θ > 0` (default `θ = 1`). */
export const gamma = {
  /**
   * Cumulative distribution `F(x; k, θ) = P(k, x/θ)`. For `k = 1` this is the exponential CDF
   * `1 − e^(−x/θ)`.
   */
  cdf(x: number, shape: number, theta = 1): number {
    requirePositive(shape, 'shape', 'gamma.cdf');
    requirePositive(theta, 'theta', 'gamma.cdf');
    if (Number.isNaN(x)) return NaN;
    if (x <= 0) return 0;
    return lowerRegGamma(shape, x / theta);
  },

  /** Quantile (inverse CDF) on `(0, ∞)`. */
  inverseCdf(probability: number, shape: number, theta = 1): number {
    requireProbability(probability, 'gamma.inverseCdf');
    requirePositive(shape, 'shape', 'gamma.inverseCdf');
    requirePositive(theta, 'theta', 'gamma.inverseCdf');
    // Mean of the distribution is k·θ.
    return invertPositiveCdf((x) => this.cdf(x, shape, theta), probability, shape * theta);
  },
} as const;

/**
 * Regularized lower incomplete gamma `P(a, x)` — exported for callers (e.g. the chi-square survival
 * used by Ljung–Box) that want the primitive directly rather than through a distribution facade.
 */
export function regularizedGammaP(a: number, x: number): number {
  requirePositive(a, 'a', 'regularizedGammaP');
  if (Number.isNaN(x)) return NaN;
  return lowerRegGamma(a, x);
}

/** Regularized incomplete beta `Iₓ(a, b)` — exported primitive behind the Student-t CDF. */
export function regularizedBeta(a: number, b: number, x: number): number {
  requirePositive(a, 'a', 'regularizedBeta');
  requirePositive(b, 'b', 'regularizedBeta');
  if (Number.isNaN(x)) return NaN;
  return regIncompleteBeta(a, b, x);
}
