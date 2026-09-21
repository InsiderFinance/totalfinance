/**
 * The Heston (1993) stochastic-volatility model (spec §9.3, §10.1).
 *
 * Risk-neutral dynamics:
 *   dS = (r − q)·S·dt + √v·S·dW₁
 *   dv = κ·(θ − v)·dt + ξ·√v·dW₂,   corr(dW₁, dW₂) = ρ
 *
 * Two independent pricers that cross-validate each other:
 *   • **COS** (Fang–Oosterlee 2008) — a Fourier-cosine expansion of the characteristic function;
 *     fast, exponentially convergent, the default analytic engine. Uses the Albrecher et al. "Little
 *     Heston Trap" branch of the CF for numerical stability across long maturities.
 *   • **QE Monte-Carlo** (Andersen 2008) — the quadratic-exponential scheme for the CIR variance
 *     plus the central log-spot discretisation; an independent check of the analytic price that also
 *     handles path-dependent payoffs.
 *
 * In the degenerate limit ξ→0 with v₀ = θ = σ², Heston collapses to Black–Scholes with volatility σ —
 * the primary correctness anchor.
 */

import {
  type Assumptions,
  CONVENTIONS_VERSION,
  ConvergenceError,
  DEFAULT_GREEK_UNITS,
  type Diagnostics,
  ErrorCode,
  InputError,
  type OptionType,
  type QuantWarning,
  ensureEnum,
  ensureFinite,
  ensurePositive,
  warning,
  WarningCode,
  requireArgumentObject,
  requireFiniteFields,
  type ClosedRequestSpecification,
  validateClosedRequest,
} from '@totalfinance/core';
import { normalCdf } from '@totalfinance/math';
import { requireOptionalArgObject } from './facade-util.js';
import { VALIDATION_SPECS } from './generated/validation-specs.js';
import { assertNoArbitrageBounds, noArbitrageCeiling } from './engines/bounds.js';
import {
  type BlackScholesImpliedVolatilityResult,
  blackScholesImpliedVolatility,
  blackScholesPrice,
} from './bsm.js';
import { type Complex, cAdd, cDiv, cExp, cLn, cMul, cScale, cSqrt, complex } from './mc/complex.js';
import {
  type MonteCarloEstimate,
  type MonteCarloStatistics,
  type MonteCarloSamplingOptions,
  monteCarloEstimate,
} from './mc/core.js';
import { finiteDifferenceExtendedGreeks, resolveFdSteps } from './engines/fd-greeks.js';
import {
  MAX_HESTON_COSINE_TERMS,
  requireHestonCosineTermCount,
} from './resource-validation-internal.js';
import type { ExtendedGreeks, Greeks, PriceResult } from './types.js';

/** Heston parameters (variances, not volatilities). */
export interface HestonParameters {
  /** Initial instantaneous variance v₀ (= σ₀²). */
  v0: number;
  /** Mean-reversion speed κ. */
  kappa: number;
  /** Long-run variance θ. */
  theta: number;
  /** Volatility of variance ξ ("vol of vol"). */
  sigma: number;
  /** Spot/variance correlation ρ ∈ [−1, 1]. */
  rho: number;
}

/** Market inputs for a Heston computation. */
export interface HestonInput {
  spot: number;
  strike: number;
  /** Time to expiry in years. */
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield?: number;
}

/** Options for the COS analytic pricer. */
export interface HestonCosineExpansionOptions {
  /** Number of cosine terms (default 256, maximum 8,192; COS converges exponentially). */
  terms?: number;
  /** Truncation width in standard deviations (default 12). */
  truncation?: number;
  /** Compute Greeks by finite differences (default `true`). */
  greeks?: boolean;
  /**
   * Compute the full higher-order (extended) Greek set (implies `greeks`). Volatility Greeks (vega, vanna, …)
   * are w.r.t. the **vol level** — `√v₀` and `√θ` bumped together — extending the `vega` convention. The
   * COS price is accurate, so the finite differences are converged (verified stable across term counts).
   */
  extendedGreeks?: boolean;
}

/** Options for the QE Monte-Carlo pricer. */
export interface HestonMonteCarloOptions extends MonteCarloSamplingOptions {
  /** Time steps per path (default 64). */
  steps?: number;
  /** Compute Greeks by common-random-number finite differences (default `false` — MC Greeks are noisy). */
  greeks?: boolean;
}

/** A Heston MC result enriched with the Monte-Carlo error statistics. */
export interface HestonMonteCarloResult extends PriceResult {
  monteCarlo: MonteCarloStatistics;
}

/** Complete, assumption-light inputs for the raw Heston COS kernel. */
export interface HestonCosineExpansionPriceInput {
  type: OptionType;
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  parameters: HestonParameters;
  /** Number of cosine terms (default 256, maximum 8,192). */
  terms?: number;
  truncation?: number;
}

/** One cohesive request for the validated Heston COS pricer or IV bridge. */
export interface HestonPriceRequest {
  type: OptionType;
  input: HestonInput;
  parameters: HestonParameters;
  options?: HestonCosineExpansionOptions;
}

/** Complete inputs for one raw Heston QE Monte-Carlo estimate. */
export interface HestonMonteCarloEstimateInput {
  type: OptionType;
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  parameters: HestonParameters;
  options: HestonMonteCarloOptions;
}

/** One cohesive request for the validated Heston QE Monte-Carlo pricer. */
export interface HestonPriceMonteCarloRequest {
  type: OptionType;
  input: HestonInput;
  parameters: HestonParameters;
  options: HestonMonteCarloOptions;
}

function validateParams(p: HestonParameters, functionName: string): QuantWarning[] {
  ensurePositive(p.v0, 'v0', functionName);
  ensurePositive(p.kappa, 'kappa', functionName);
  ensurePositive(p.theta, 'theta', functionName);
  ensurePositive(p.sigma, 'sigma', functionName);
  ensureFinite(p.rho, 'rho', functionName);
  if (p.rho < -1 || p.rho > 1) {
    throw new InputError(`${functionName}: rho must be in [-1, 1], got ${p.rho}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { rho: p.rho },
    });
  }
  const warnings: QuantWarning[] = [];
  if (2 * p.kappa * p.theta < p.sigma * p.sigma) {
    warnings.push(
      warning(
        WarningCode.HestonFellerViolated,
        `Feller condition 2κθ ≥ ξ² is violated (2·${p.kappa}·${p.theta} < ${p.sigma}²); the variance process can reach zero, ` +
          'so the parameters imply a heavy left tail. The QE Monte-Carlo scheme (heston.monteCarloPrice) handles this ' +
          'regime by construction and is the reliable engine here; the COS expansion does NOT handle it automatically — ' +
          'its default 256 terms can leave a 3% error at long maturities, which shows up as ' +
          'converged:false + engine.discretization_inadequate rather than as a silent number.',
        'info',
        { kappa: p.kappa, theta: p.theta, sigma: p.sigma },
      ),
    );
  }
  return warnings;
}

/**
 * Heston characteristic function of `y = ln(S_T / K)` evaluated at real frequency `u`, using the
 * Little-Heston-Trap branch (Albrecher et al. 2007).
 */
function hestonCf(input: {
  frequency: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  parameters: HestonParameters;
  initialLogMoneyness: number;
}): Complex {
  const {
    frequency: u,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    parameters: p,
    initialLogMoneyness: x0,
  } = input;
  const { v0, kappa, theta, sigma, rho } = p;
  // term = κ − ρξ·iu
  const term: Complex = { re: kappa, im: -u * rho * sigma };
  // d = √((ρξ·iu − κ)² + ξ²·(iu + u²))
  const a1: Complex = { re: -kappa, im: u * rho * sigma };
  const a1sq = cMul(a1, a1);
  const b1: Complex = { re: sigma * sigma * u * u, im: sigma * sigma * u };
  const d = cSqrt(cAdd(a1sq, b1));
  const tm = { re: term.re - d.re, im: term.im - d.im }; // κ − ρξiu − d
  const tp = { re: term.re + d.re, im: term.im + d.im }; // κ − ρξiu + d
  const g2 = cDiv(tm, tp); // little-trap g
  const edt = cExp(cScale(d, -T));
  const one = complex(1, 0);
  const G = cDiv(cSub1(one, cMul(g2, edt)), cSub1(one, g2));
  const lnG = cLn(G);
  // C = (κθ/ξ²)·[(κ−ρξiu−d)·T − 2·lnG]
  const Cpart = cScale(cSub1(cScale(tm, T), cScale(lnG, 2)), (kappa * theta) / (sigma * sigma));
  // D = (κ−ρξiu−d)/ξ² · (1 − e^{−dT})/(1 − g·e^{−dT})
  const Dfrac = cDiv(cSub1(one, edt), cSub1(one, cMul(g2, edt)));
  const D = cMul(cScale(tm, 1 / (sigma * sigma)), Dfrac);
  // exponent = iu·((r−q)T + x0) + C + D·v0
  const drift = (r - q) * T + x0;
  const exponent = cAdd(cAdd({ re: 0, im: u * drift }, Cpart), cScale(D, v0));
  return cExp(exponent);
}

function cSub1(a: Complex, b: Complex): Complex {
  return { re: a.re - b.re, im: a.im - b.im };
}

/** χ_k integral on [c, d] (Fang–Oosterlee 2008, eq. 22). */
function chi(input: {
  term: number;
  lowerBound: number;
  upperBound: number;
  integrationLower: number;
  integrationUpper: number;
}): number {
  const { term: k, lowerBound: a, upperBound: b, integrationLower: c, integrationUpper: d } = input;
  const kp = (k * Math.PI) / (b - a);
  const denom = 1 + kp * kp;
  const ec = Math.exp(c);
  const ed = Math.exp(d);
  const cd = kp * (d - a);
  const cc = kp * (c - a);
  return (
    (1 / denom) *
    (Math.cos(cd) * ed - Math.cos(cc) * ec + kp * Math.sin(cd) * ed - kp * Math.sin(cc) * ec)
  );
}

/** ψ_k integral on [c, d] (Fang–Oosterlee 2008, eq. 23). */
function psi(input: {
  term: number;
  lowerBound: number;
  upperBound: number;
  integrationLower: number;
  integrationUpper: number;
}): number {
  const { term: k, lowerBound: a, upperBound: b, integrationLower: c, integrationUpper: d } = input;
  if (k === 0) return d - c;
  const kp = (k * Math.PI) / (b - a);
  return (Math.sin(kp * (d - a)) - Math.sin(kp * (c - a))) / kp;
}

/** COS series coefficient V_k for a vanilla payoff of strike K on log-return domain [a, b]. */
function payoffCoef(input: {
  type: OptionType;
  term: number;
  lowerBound: number;
  upperBound: number;
  strike: number;
}): number {
  const { type, term: k, lowerBound: a, upperBound: b, strike: K } = input;
  const f = (2 / (b - a)) * K;
  return type === 'call'
    ? f *
        (chi({ term: k, lowerBound: a, upperBound: b, integrationLower: 0, integrationUpper: b }) -
          psi({ term: k, lowerBound: a, upperBound: b, integrationLower: 0, integrationUpper: b }))
    : f *
        (-chi({ term: k, lowerBound: a, upperBound: b, integrationLower: a, integrationUpper: 0 }) +
          psi({ term: k, lowerBound: a, upperBound: b, integrationLower: a, integrationUpper: 0 }));
}

/** Heston cumulants c1, c2 of `ln(S_T/K)` for the COS truncation range. */
function cumulants(input: {
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  parameters: HestonParameters;
  initialLogMoneyness: number;
}): [number, number] {
  const {
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    parameters: p,
    initialLogMoneyness: x0,
  } = input;
  const { v0, kappa, theta, sigma, rho } = p;
  const ekt = Math.exp(-kappa * T);
  const c1 = x0 + (r - q) * T + ((1 - ekt) * (theta - v0)) / (2 * kappa) - 0.5 * theta * T;
  const c2 =
    (1 / (8 * kappa ** 3)) *
    (sigma * T * kappa * ekt * (v0 - theta) * (8 * kappa * rho - 4 * sigma) +
      kappa * rho * sigma * (1 - ekt) * (16 * theta - 8 * v0) +
      2 * theta * kappa * T * (-4 * kappa * rho * sigma + sigma * sigma + 4 * kappa * kappa) +
      sigma *
        sigma *
        ((theta - 2 * v0) * Math.exp(-2 * kappa * T) + theta * (6 * ekt - 7) + 2 * v0) +
      8 * kappa * kappa * (v0 - theta) * (1 - ekt));
  return [c1, c2];
}

/**
 * Fourth cumulant `c₄` of `ln(S_T/S₀)`, from a central stencil on `ln|φ(u)|` (Fang–Oosterlee's COS
 * truncation range uses `c₁ ± L·√(|c₂| + √|c₄|)`; dropping `c₄` truncates a fat-tailed variance
 * process too narrowly, which is one half of the long-dated/high-ξ error).
 *
 * `Re ln φ(u) = ln|φ(u)|` is branch-free, and its even expansion is `−c₂u²/2 + c₄u⁴/24 − …`, so
 *
 *   2·ln|φ(2h)| − 8·ln|φ(h)| = (−4c₂h² + 4c₂h²) + ((32 − 8)/24)·c₄h⁴ = c₄h⁴,
 *
 * i.e. the `c₂` terms cancel exactly and the leading residual is O(c₆h²). `c₄` is shift-invariant, so
 * the log-moneyness offset is taken as 0.
 */
function fourthCumulant(input: {
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  parameters: HestonParameters;
}): number {
  const { timeToExpiryYears: T, riskFreeRate: r, dividendYield: q, parameters: p } = input;
  const logAbsCf = (u: number): number => {
    const cf = hestonCf({
      frequency: u,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
      parameters: p,
      initialLogMoneyness: 0,
    });
    return 0.5 * Math.log(cf.re * cf.re + cf.im * cf.im);
  };
  const h = 0.5;
  const c4 = (2 * logAbsCf(2 * h) - 8 * logAbsCf(h)) / h ** 4;
  return Number.isFinite(c4) ? c4 : 0;
}

/**
 * Tail-decay ceiling for a converged COS series: the last terms of a geometrically decaying
 * expansion are numerically negligible against its largest term. Well-conditioned Heston parameter
 * sets land 5+ orders of magnitude below this; the L=40/T=10 divergence and the Feller-violating
 * long-dated case land above it.
 */
const COS_TAIL_TOLERANCE = 1e-8;

/**
 * How much the price may move when the truncation range is widened by {@link COS_RANGE_WIDENING}
 * before the DOMAIN (as opposed to the series) is called inadequate.
 *
 * The tail check above sees only series truncation. The other half of the COS error is the range
 * `c₁ ± L·√(|c₂| + √|c₄|)` itself: for a Feller-violating variance process the cumulants understate
 * the tail, and the sum converges beautifully to the wrong number — 23.81 at L=12 against 23.12 at
 * L=8, 25.16 at L=16, and a QE-MC reference of 21.5. Measured drift on well-behaved parameter sets
 * (short and long dated, ITM/ATM/OTM, tiny and large ξ) is ≤ 5.4e-7; this sits 20× above that.
 */
const COS_TRUNCATION_TOLERANCE = 1e-5;

/** Relative widening of `L` used for the domain-stability check. */
const COS_RANGE_WIDENING = 1.25;

/**
 * Sum the expansion, refining the term count while the series has demonstrably not converged.
 *
 * Refinement applies only when the caller did NOT pin `terms`: an explicit `terms: 8` is a request to
 * see what 8 terms do, and is answered with 8 terms and an honest flag. On the DEFAULT path a
 * Feller-violating long-dated set (2κθ ≪ ξ², T = 5) needs ~4× the default terms, and quadrupling
 * until the tail decays turns a 3%-wrong silent number into the right one.
 */
function hestonCosRefined(
  input: Required<HestonCosineExpansionPriceInput> & { allowRefinement: boolean },
): { summary: HestonCosSummary; terms: number } {
  let terms = input.terms;
  let summary = hestonCosSummary({ ...input, terms });
  if (!input.allowRefinement) return { summary, terms };
  while (summary.tailRatio > COS_TAIL_TOLERANCE && terms < MAX_HESTON_COSINE_TERMS) {
    terms = Math.min(terms * 4, MAX_HESTON_COSINE_TERMS);
    summary = hestonCosSummary({ ...input, terms });
  }
  return { summary, terms };
}

/** A completed COS sum plus the evidence that the series actually converged. */
interface HestonCosSummary {
  /** Raw (unclamped) discounted value. */
  value: number;
  /**
   * Largest |term| in the final tenth of the series, relative to the largest |term| overall. A
   * converged Fourier-cosine expansion decays geometrically, so this is ~1e-10 or below; an O(1)
   * ratio means the truncation range and the term count disagree and the SUM IS MEANINGLESS —
   * including when it happens to land on a plausible positive number.
   */
  tailRatio: number;
}

/**
 * Raw (unclamped) COS discounted value with its tail-decay evidence. A well-conditioned COS sum
 * lands at the true (non-negative) price; a blown-up truncation/parameter set can drive it materially
 * negative — or to +9.5e4 — and the caller uses the sign AND the tail ratio to decide whether the
 * clamped price is trustworthy (WS2.10) rather than silently returning it.
 */
function hestonCosSummary(input: Required<HestonCosineExpansionPriceInput>): HestonCosSummary {
  const {
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    parameters: p,
    terms,
    truncation: L,
  } = input;
  const x0 = Math.log(S / K);
  const [c1, c2] = cumulants({
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    parameters: p,
    initialLogMoneyness: x0,
  });
  const c4 = fourthCumulant({
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    parameters: p,
  });
  const width = L * Math.sqrt(Math.abs(c2) + Math.sqrt(Math.abs(c4)));
  const a = c1 - width;
  const b = c1 + width;
  const span = b - a;
  let sum = 0;
  let peak = 0;
  let tail = 0;
  const tailStart = Math.max(1, terms - Math.max(4, Math.ceil(terms / 10)));
  for (let k = 0; k < terms; k++) {
    const kp = (k * Math.PI) / span;
    const cf = hestonCf({
      frequency: kp,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
      parameters: p,
      initialLogMoneyness: x0,
    });
    const ua = kp * a;
    // Re(cf · e^{−i·kp·a})
    let Fk = cf.re * Math.cos(ua) + cf.im * Math.sin(ua);
    if (k === 0) Fk *= 0.5;
    const term =
      Fk *
      payoffCoef({
        type,
        term: k,
        lowerBound: a,
        upperBound: b,
        strike: K,
      });
    sum += term;
    const magnitude = Math.abs(term);
    if (magnitude > peak) peak = magnitude;
    if (k >= tailStart && magnitude > tail) tail = magnitude;
  }
  return {
    value: Math.exp(-r * T) * sum,
    tailRatio: peak > 0 ? tail / peak : 0,
  };
}

/**
 * The variance-of-variance below which the COS characteristic function loses the price to
 * catastrophic cancellation, and the deterministic-variance limit is used instead.
 *
 * The Heston CF divides by `ξ²` in both `C` and `D`; as ξ→0 those terms are differences of nearly
 * equal large numbers, and the reconstructed price drifts and then explodes. Measured against the
 * BSM anchor at `v₀ = 0.04, κ = 1.5, θ = 0.05, ρ = −0.6`:
 *
 *   ξ²T      1e-5     1e-6      9e-7      1e-7      1e-8      1e-10
 *   COS err  0.016%   0.0005%   1.35%     8.8%      0.042%    +3275%
 *
 * The error is not monotone (it is cancellation, not truncation), so the switch is placed at the
 * last value that is still uniformly accurate: `ξ²·T ≤ 1e-6` uses the limit. At the switch the
 * limit's OWN error — the genuine smile it drops — is 0.0005% at the money and 0.18% for a 30%
 * out-of-the-money strike, i.e. under a third of a cent on a $100 spot.
 */
const DETERMINISTIC_VARIANCE_THRESHOLD = 1e-6;

/**
 * The volatility of the deterministic ξ→0 limit: the time-average of the mean-reverting variance,
 * `σ̄² = θ + (v₀ − θ)·(1 − e^{−κT})/(κT)`. Heston with ξ = 0 IS Black–Scholes at this volatility.
 *
 * Intentionally module-private: it is a documented internal limit, not a new public surface in a
 * defect-fix wave (the tests that pin it recompute the closed form independently).
 */
function hestonIntegratedVolatility(input: {
  parameters: HestonParameters;
  timeToExpiryYears: number;
}): number {
  const { parameters: p, timeToExpiryYears: T } = input;
  const meanReversion = p.kappa * T;
  const weight = meanReversion > 0 ? (1 - Math.exp(-meanReversion)) / meanReversion : 1;
  return Math.sqrt(Math.max(0, p.theta + (p.v0 - p.theta) * weight));
}

/** Whether the deterministic-variance (BSM) limit replaces the COS expansion for these parameters. */
function usesDeterministicVarianceLimit(p: HestonParameters, T: number): boolean {
  return p.sigma * p.sigma * T <= DETERMINISTIC_VARIANCE_THRESHOLD;
}

/**
 * The raw Heston COS price (clamped ≥ 0).
 *
 * This is still the direct, assumption-light kernel; named fields prevent silent transposition of
 * its homogeneous financial values. Algorithm controls retain documented defaults.
 *
 * Expert kernel form (model-subpath surface) — the curated root surface is {@link heston.cosineExpansion}.
 */
/** The Heston state vector, and the market legs a price needs alongside it. */
const HESTON_PARAM_FIELDS = ['v0', 'kappa', 'theta', 'sigma', 'rho'] as const;
const HESTON_MARKET_FIELDS = [
  'spot',
  'strike',
  'timeToExpiryYears',
  'riskFreeRate',
  'dividendYield',
] as const;

/**
 * Names `hestonCosineExpansionPrice`, the function the error reports.
 *
 * It used to name `heston.cosineExpansion`. That is a genuine alias — the same function object on
 * the `heston` facade — so the example ran; but "the error says X, the fix says Y" makes the reader
 * do the alias resolution, and a gate cannot distinguish a true alias from misdirection without
 * being told. Naming the reported function needs no such exception.
 */
const HESTON_EXAMPLE_CALL =
  "hestonCosineExpansionPrice({ type: 'call', spot: 100, strike: 105, timeToExpiryYears: 0.25, " +
  'riskFreeRate: 0.04, dividendYield: 0, parameters: { v0: 0.04, kappa: 1.5, theta: 0.04, sigma: 0.5, rho: -0.7 } })';

const HESTON_HINTS: Record<string, string> = {
  v0: 'initial VARIANCE, not volatility — 0.2 squared is 0.04',
  theta: 'long-run VARIANCE',
  sigma: 'vol-of-vol (xi)',
  rho: 'spot/variance correlation, in [-1, 1]',
  kappa: 'mean-reversion speed',
  volatility: 'annualized decimal, not 20',
};

/**
 * Validate a Heston request: the market legs, then the state vector NESTED under `parameters`.
 *
 * Reported as `parameters.kappa`, not `kappa` — the caller is holding a market request with a model
 * object inside it, and the bare field name does not say which one to fix. Every one of these was
 * unchecked: the expansion consumed `undefined`, and the characteristic function returned NaN.
 */
// The name is a literal, not a parameter. There is exactly one caller, and a variable here would
// force the example gate to accept a fixed example it has no way to verify — which is precisely how
// the shared-validator defects in `costs.ts`, `svi.ts` and `transforms.ts` stayed hidden.
function requireHestonRequest(input: { parameters: HestonParameters }): void {
  requireFiniteFields('hestonCosineExpansionPrice', input, HESTON_MARKET_FIELDS, {
    exampleCall: HESTON_EXAMPLE_CALL,
    hints: HESTON_HINTS,
  });
  requireFiniteFields('hestonCosineExpansionPrice', input.parameters, HESTON_PARAM_FIELDS, {
    exampleCall: HESTON_EXAMPLE_CALL,
    hints: HESTON_HINTS,
    path: 'parameters',
  });
}

/**
 * @internal File-private, unchecked COS price.
 *
 * `cosGreeks` below builds its Greeks by FINITE DIFFERENCE — it re-prices the same contract with
 * bumped spot, vol and time, several times per Greek. Routing those bumps through the guarded entry
 * re-validated the market legs AND the five nested `parameters` fields on every bump, to compute a
 * derivative of a function whose inputs had already been checked once. `./heston` is a public
 * subpath, so this stays file-private rather than exported.
 */
function cosineExpansionPriceUnchecked(input: HestonCosineExpansionPriceInput): number {
  const { type, parameters, terms = 256, truncation = 12 } = input;
  // Below the threshold the expansion is pure cancellation noise; the documented ξ→0 limit is both
  // the honest and the accurate answer (see DETERMINISTIC_VARIANCE_THRESHOLD).
  if (usesDeterministicVarianceLimit(parameters, input.timeToExpiryYears)) {
    return blackScholesPrice({
      type,
      spot: input.spot,
      strike: input.strike,
      timeToExpiryYears: input.timeToExpiryYears,
      riskFreeRate: input.riskFreeRate,
      dividendYield: input.dividendYield,
      volatility: hestonIntegratedVolatility({
        parameters,
        timeToExpiryYears: input.timeToExpiryYears,
      }),
    });
  }
  return Math.max(
    0,
    hestonCosRefined({
      ...input,
      terms,
      truncation,
      allowRefinement: input.terms === undefined,
    }).summary.value,
  );
}

/**
 * Generated closed-request specs (spec 3B.1b): allowlists projected from the declarations.
 * Resolved at module load so a stale key fails at import. The `heston.*` namespace aliases the
 * same implementations, so one validation head serves both spellings.
 */
function hestonSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `heston: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const HESTON_COSINE_SPEC = hestonSpecOf('hestonCosineExpansionPrice#0');
const HESTON_FIRST_ORDER_SPEC = hestonSpecOf('hestonFirstOrderSteps#0');
const HESTON_PRICE_SPEC = hestonSpecOf('hestonPrice#0');
const HESTON_IV_SPEC = hestonSpecOf('hestonImpliedVolatility#0');
const HESTON_MC_ESTIMATE_SPEC = hestonSpecOf('hestonMonteCarloEstimate#0');
const HESTON_MC_PRICE_SPEC = hestonSpecOf('hestonMonteCarloPrice#0');

const HESTON_EXAMPLE = (): string =>
  "heston.price({ type: 'call', input: { spot: 100, strike: 105, timeToExpiryYears: 0.25, riskFreeRate: 0.04 }, parameters: { v0: 0.04, kappa: 1.5, theta: 0.04, sigma: 0.3, rho: -0.6 } })";

export function hestonCosineExpansionPrice(input: HestonCosineExpansionPriceInput): number {
  validateClosedRequest('hestonCosineExpansionPrice', input, HESTON_COSINE_SPEC, {
    exampleCall: HESTON_EXAMPLE,
  });
  // `type` is a meaning-changing string: unvalidated garbage would silently price the other leg.
  ensureEnum(input.type, ['call', 'put'] as const, 'type', 'hestonCosineExpansionPrice');
  requireArgumentObject('hestonCosineExpansionPrice', 'parameters', input.parameters);
  requireHestonRequest(input);
  requireHestonCosineTermCount('hestonCosineExpansionPrice', input.terms);
  return cosineExpansionPriceUnchecked(input);
}

function assumptions(t: number, q: number, engine: string): Assumptions {
  return {
    conventionsVersion: CONVENTIONS_VERSION,
    dayCount: 'ACT/365F',
    compounding: 'continuous',
    timeToExpiryYears: t,
    dividendModel: q === 0 ? 'none' : 'continuousYield',
    units: DEFAULT_GREEK_UNITS,
    model: 'heston',
    engine,
  };
}

/** Finite-difference Greeks for the COS price. `vega` is sensitivity to the overall vol level (√v₀, √θ). */
function cosGreeks(
  input: Required<HestonCosineExpansionPriceInput> & { extended: boolean },
): Greeks | ExtendedGreeks {
  const {
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    parameters: p,
    terms,
    truncation,
    extended,
  } = input;
  const price = (priceInput: {
    spot: number;
    timeToExpiryYears: number;
    riskFreeRate: number;
    parameters: HestonParameters;
  }): number =>
    cosineExpansionPriceUnchecked({
      type,
      spot: priceInput.spot,
      strike: K,
      timeToExpiryYears: priceInput.timeToExpiryYears,
      riskFreeRate: priceInput.riskFreeRate,
      dividendYield: q,
      parameters: priceInput.parameters,
      terms,
      truncation,
    });

  // The vol level is √v₀ (= √θ at the base); bumping both together shifts it (see the vega block below).
  const bump = (shift: number): HestonParameters => ({
    ...p,
    v0: (Math.sqrt(p.v0) + shift) ** 2,
    theta: (Math.sqrt(p.theta) + shift) ** 2,
  });
  if (extended) {
    // A scalar-shift price closure (shift = 0 at base) around which the shared helper differences.
    const priceVL = ({
      spot,
      volatility: shift,
      timeToExpiryYears,
      riskFreeRate,
      dividendYield,
    }: {
      spot: number;
      volatility: number;
      timeToExpiryYears: number;
      riskFreeRate: number;
      dividendYield: number;
    }): number =>
      cosineExpansionPriceUnchecked({
        type,
        spot,
        strike: K,
        timeToExpiryYears,
        riskFreeRate,
        dividendYield,
        parameters: bump(shift),
        terms,
        truncation,
      });
    // Shift-mode (sigma is a shift around 0): scale the vol bump to the model's OWN level so
    // √v₀ + shift / √θ + shift never cross zero for tiny-vol calibrations (spec P2.3).
    const volatilityStep = hestonVolatilityShiftBump(p);
    return finiteDifferenceExtendedGreeks({
      price: priceVL,
      spotAt: () => S,
      state: { spot: S, T, r, q, sigma: 0 },
      steps: { volatilityStep },
    });
  }

  const base = price({ spot: S, timeToExpiryYears: T, riskFreeRate: r, parameters: p });
  // ONE resolution (D6): these exact sizes are used for differencing AND returned so the caller
  // discloses precisely what ran — never a recomputed approximation of it.
  const fo = hestonFirstOrderSteps({ spot: S, timeToExpiryYears: T, parameters: p });

  const pSup = price({
    spot: S + fo.spotStep,
    timeToExpiryYears: T,
    riskFreeRate: r,
    parameters: p,
  });
  const pSdn = price({
    spot: S - fo.spotStep,
    timeToExpiryYears: T,
    riskFreeRate: r,
    parameters: p,
  });
  const delta = (pSup - pSdn) / (2 * fo.spotStep);
  const gamma = (pSup - 2 * base + pSdn) / (fo.spotStep * fo.spotStep);
  const theta =
    -(
      price({ spot: S, timeToExpiryYears: T + fo.timeStepYears, riskFreeRate: r, parameters: p }) -
      price({ spot: S, timeToExpiryYears: T - fo.timeStepYears, riskFreeRate: r, parameters: p })
    ) /
    (2 * fo.timeStepYears) /
    365;
  const rho =
    (price({ spot: S, timeToExpiryYears: T, riskFreeRate: r + fo.rateStep, parameters: p }) -
      price({ spot: S, timeToExpiryYears: T, riskFreeRate: r - fo.rateStep, parameters: p })) /
    (2 * fo.rateStep) /
    100;

  // Vega: bump the vol *level* (√v₀ and √θ together) so the BSM limit reproduces BSM vega.
  const vega =
    (price({
      spot: S,
      timeToExpiryYears: T,
      riskFreeRate: r,
      parameters: bump(fo.volatilityStep),
    }) -
      price({
        spot: S,
        timeToExpiryYears: T,
        riskFreeRate: r,
        parameters: bump(-fo.volatilityStep),
      })) /
    (2 * fo.volatilityStep) /
    100;

  return { delta, gamma, theta, vega, rho };
}

/** Heston vol-level shift bump, scaled to the model's own level (P2.3). */
function hestonVolatilityShiftBump(p: HestonParameters): number {
  const level = Math.min(Math.sqrt(p.v0), Math.sqrt(p.theta));
  return level > 0 ? Math.min(1e-3, level / 4) : 1e-3;
}

/** The EXACT first-order FD sizes cosGreeks differences with — shared with the disclosure (D6). */
export interface HestonFirstOrderStepsInput {
  spot: number;
  timeToExpiryYears: number;
  parameters: HestonParameters;
}

export function hestonFirstOrderSteps(input: HestonFirstOrderStepsInput): {
  spotStep: number;
  volatilityStep: number;
  timeStepYears: number;
  rateStep: number;
} {
  validateClosedRequest('hestonFirstOrderSteps', input, HESTON_FIRST_ORDER_SPEC, {
    exampleCall: HESTON_EXAMPLE,
  });
  requireArgumentObject('hestonFirstOrderSteps', 'input', input);
  const { spot: S, timeToExpiryYears: T, parameters: p } = input;
  requireArgumentObject('hestonFirstOrderSteps', 'parameters', p);
  ensureFinite(S, 'S', 'hestonFirstOrderSteps');
  ensureFinite(T, 'T', 'hestonFirstOrderSteps');
  return {
    spotStep: S * 1e-4,
    volatilityStep: hestonVolatilityShiftBump(p),
    timeStepYears: Math.min(1e-4, T / 4),
    rateStep: 1e-4,
  };
}

/**
 * Price a European option under Heston via the COS method, with finite-difference Greeks.
 *
 * Expert kernel form (model-subpath surface) — the curated root surface is {@link heston.price}.
 */
export function hestonPrice(request: HestonPriceRequest): PriceResult {
  validateClosedRequest('hestonPrice', request, HESTON_PRICE_SPEC, {
    argumentName: 'request',
    subject: true,
    exampleCall: HESTON_EXAMPLE,
  });
  const { type, input, parameters, options: options = {} } = request;
  const functionName = 'hestonPrice';
  // `type: 'Call'` must teach, not silently price the other leg (design law #4).
  ensureEnum(type, ['call', 'put'] as const, 'type', functionName);
  requireArgumentObject(functionName, 'input', input);
  requireArgumentObject(functionName, 'parameters', parameters);
  // `null` (or a primitive) slips past `options = {}` — teach, never TypeError on `options.terms`.
  requireOptionalArgObject(functionName, 'options', options);
  requireHestonCosineTermCount(functionName, options.terms);
  ensurePositive(input.spot, 'spot', functionName);
  ensurePositive(input.strike, 'strike', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
  const q = input.dividendYield ?? 0;
  ensureFinite(q, 'dividendYield', functionName);
  const warnings = validateParams(parameters, functionName);

  const requestedTerms = options.terms ?? 256;
  const L = options.truncation ?? 12;
  const T = input.timeToExpiryYears;
  // Below the cancellation threshold the expansion cannot resolve the price at all; the documented
  // ξ→0 limit (BSM at the integrated variance) is used and DISCLOSED via diagnostics.method.
  const deterministicLimit = usesDeterministicVarianceLimit(parameters, T);
  const refined = deterministicLimit
    ? { summary: { value: NaN, tailRatio: 0 }, terms: requestedTerms }
    : hestonCosRefined({
        type,
        spot: input.spot,
        strike: input.strike,
        timeToExpiryYears: T,
        riskFreeRate: input.riskFreeRate,
        dividendYield: q,
        parameters,
        terms: requestedTerms,
        truncation: L,
        allowRefinement: options.terms === undefined,
      });
  const summary = refined.summary;
  const terms = refined.terms;
  const integratedVolatility = hestonIntegratedVolatility({ parameters, timeToExpiryYears: T });
  const raw = summary.value;
  const value = deterministicLimit
    ? blackScholesPrice({
        type,
        spot: input.spot,
        strike: input.strike,
        timeToExpiryYears: T,
        riskFreeRate: input.riskFreeRate,
        dividendYield: q,
        volatility: integratedVolatility,
      })
    : Math.max(0, raw);
  if (deterministicLimit) {
    warnings.push(
      warning(
        // A structural limitation of the COS method at this parameter set, not a solver failure.
        WarningCode.ModelLimitation,
        `vol-of-vol ξ=${parameters.sigma} gives ξ²·T=${(parameters.sigma * parameters.sigma * T).toExponential(2)} ≤ ` +
          `${DETERMINISTIC_VARIANCE_THRESHOLD.toExponential(0)}, where the COS characteristic function loses the price to ` +
          `catastrophic cancellation (1/ξ² terms). Priced in the exact ξ→0 limit instead: Black–Scholes at the ` +
          `integrated volatility σ̄=${integratedVolatility.toFixed(6)} (σ̄² = θ + (v₀−θ)(1−e^{−κT})/(κT)). The smile this ` +
          'drops is below 0.2% of the premium at these parameters.',
        'info',
        { sigma: parameters.sigma, timeToExpiryYears: T, integratedVolatility },
      ),
    );
  }
  // A COS sum that lands materially below zero (beyond a tiny numerical slop) has blown up — the
  // clamp to 0 keeps the value sane, but the price is NOT trustworthy. Flag it instead of pretending
  // it converged (design law #4). Threshold scales with spot so it is dimensionless in moneyness.
  const cosUnstable = !deterministicLimit && raw < -1e-8 * input.spot;
  if (cosUnstable) {
    warnings.push({
      code: WarningCode.HestonCosineExpansionUnstable,
      message: `Heston COS sum is unstable (raw pre-clamp value ${raw.toExponential(
        3,
      )} < 0); clamped to 0 but not trustworthy — widen truncation (L) or reduce terms.`,
      severity: 'warn',
      context: { raw, terms, truncation: L },
    });
  }
  // Two independent failure modes, both of which used to pass silently:
  //   • the SERIES has not converged — its last terms are not negligible (L=40, T=10 sums to 9.5e4);
  //   • the DOMAIN has not converged — the sum is clean but depends on the truncation range, which
  //     means the cumulants understated the tail (a Feller-violating set drifts 3.9e-2 when L moves
  //     12 → 15, while well-behaved sets move ≤ 5.4e-7).
  const seriesInadequate = !deterministicLimit && summary.tailRatio > COS_TAIL_TOLERANCE;
  const widened = deterministicLimit
    ? summary
    : hestonCosSummary({
        type,
        spot: input.spot,
        strike: input.strike,
        timeToExpiryYears: T,
        riskFreeRate: input.riskFreeRate,
        dividendYield: q,
        parameters,
        terms,
        truncation: L * COS_RANGE_WIDENING,
      });
  const domainDrift = deterministicLimit
    ? 0
    : Math.abs(widened.value - summary.value) /
      Math.max(Math.abs(summary.value), 1e-4 * input.spot);
  const domainInadequate = !deterministicLimit && domainDrift > COS_TRUNCATION_TOLERANCE;
  const truncationInadequate = seriesInadequate || domainInadequate;
  if (truncationInadequate) {
    warnings.push(
      warning(
        ErrorCode.EngineDiscretizationInadequate,
        (seriesInadequate
          ? `the COS series has not converged: its last terms are still ${summary.tailRatio.toExponential(2)} of ` +
            `the largest term (a converged expansion decays to ≤ ${COS_TAIL_TOLERANCE.toExponential(0)}). `
          : `the COS truncation RANGE has not converged: widening L from ${L} to ${(L * COS_RANGE_WIDENING).toFixed(2)} ` +
            `moves the price by ${(domainDrift * 100).toPrecision(3)}% (a converged range moves it by ` +
            `≤ ${(COS_TRUNCATION_TOLERANCE * 100).toExponential(0)}%), so the cumulants c₁, c₂, c₄ understate this ` +
            "variance process's tail. ") +
          'The value is NOT trustworthy. For a Feller-violating parameter set (2κθ < ξ²) the reliable engine is ' +
          'the QE Monte-Carlo — heston.monteCarloPrice; otherwise raise terms or bring truncation back toward ' +
          'the default 12.',
        'warn',
        { tailRatio: summary.tailRatio, domainDrift, terms, truncation: L },
      ),
    );
    // An inadequate expansion that ALSO breaches the no-arbitrage ceiling is not a library defect to
    // report — it is these controls failing on these parameters, and the fix is in the caller's hands.
    const ceiling = noArbitrageCeiling({
      type,
      style: 'european',
      underlyingPresentValue: input.spot * Math.exp(-q * T),
      strikePresentValue: input.strike * Math.exp(-input.riskFreeRate * T),
      spot: input.spot,
      strike: input.strike,
    });
    if (value > ceiling) {
      throw new ConvergenceError(
        `hestonPrice: the COS expansion diverged — it sums to ${value.toExponential(3)}, above the no-arbitrage ` +
          `ceiling ${ceiling.toFixed(4)}, with its last terms still ${summary.tailRatio.toExponential(2)} of the ` +
          `largest. Raise terms or reduce truncation (currently ${L}; the default 12 is calibrated for T ≤ ~2), or ` +
          'price this parameter set with heston.monteCarloPrice.',
        {
          code: ErrorCode.SolverNoConvergence,
          context: { value, ceiling, terms, truncation: L, tailRatio: summary.tailRatio },
        },
      );
    }
  }
  const wantExtended = options.extendedGreeks ?? false;
  const wantGreeks = wantExtended || (options.greeks ?? true);
  const greeks = wantGreeks
    ? cosGreeks({
        type,
        spot: input.spot,
        strike: input.strike,
        timeToExpiryYears: input.timeToExpiryYears,
        riskFreeRate: input.riskFreeRate,
        dividendYield: q,
        parameters,
        terms,
        truncation: L,
        extended: wantExtended,
      })
    : undefined;

  // The ACTUAL bump sizes the Greeks path differences with (D6): extended = the shared
  // resolveFdSteps sizes with the level-scaled vol shift; first-order = cosGreeks' own sizes.
  // Both come from the SAME functions the differencing uses — disclosure can't drift.
  const hestonFd = !wantGreeks
    ? undefined
    : wantExtended
      ? resolveFdSteps(
          { spot: input.spot, T: input.timeToExpiryYears, r: input.riskFreeRate, q, sigma: 0 },
          { volatilityStep: hestonVolatilityShiftBump(parameters) },
        )
      : hestonFirstOrderSteps({
          spot: input.spot,
          timeToExpiryYears: input.timeToExpiryYears,
          parameters,
        });
  const diagnostics: Diagnostics = {
    engine: 'heston',
    // The method is the one that actually ran — a caller reading `cos` when the deterministic limit
    // priced the contract would misattribute both the value and its error.
    method: deterministicLimit ? 'bsm-deterministic-variance-limit' : 'cos',
    converged: Number.isFinite(value) && !cosUnstable && !truncationInadequate,
    iterations: terms,
    ...(hestonFd !== undefined
      ? {
          finiteDifferenceBumps: {
            spotStep: hestonFd.spotStep,
            volatilityStep: hestonFd.volatilityStep,
            timeStepYears: hestonFd.timeStepYears,
            rateStep: hestonFd.rateStep,
            // The extended set additionally bumps the carry; first-order never touches q.
            ...('dividendYieldStep' in hestonFd
              ? { dividendYieldStep: (hestonFd as { dividendYieldStep: number }).dividendYieldStep }
              : {}),
          },
        }
      : {}),
    warnings: wantGreeks
      ? warnings
      : [
          ...warnings,
          {
            code: WarningCode.GreeksNotComputed,
            message: 'Greeks were not computed (greeks: false).',
            severity: 'info' as const,
          },
        ],
  };
  // Structural postcondition (defect-fix wave, finding 5): a European Heston value that breaches
  // 0 ≤ C ≤ S·e^{−qT} / 0 ≤ P ≤ K·e^{−rT} is a defect, not a price.
  assertNoArbitrageBounds({
    engine: deterministicLimit ? 'heston-deterministic-variance-limit' : 'heston-cos',
    type,
    style: 'european',
    value,
    underlyingPresentValue: input.spot * Math.exp(-q * T),
    strikePresentValue: input.strike * Math.exp(-input.riskFreeRate * T),
    spot: input.spot,
    strike: input.strike,
  });
  return {
    value,
    ...(greeks ? { greeks } : {}),
    assumptions: assumptions(
      input.timeToExpiryYears,
      q,
      deterministicLimit ? 'heston-deterministic-variance-limit' : 'heston-cos',
    ),
    diagnostics,
  };
}

/**
 * Black–Scholes implied volatility of the Heston COS price — the bridge to a Heston vol surface.
 * Returns the standard IV envelope: on a failed inversion `value` is `NaN` but `converged` is `false`
 * with a machine-readable `reason` (design law #4 — a bare NaN would hide why).
 *
 * Expert kernel form (model-subpath surface) — the curated root surface is {@link heston.impliedVolatility}.
 */
export function hestonImpliedVolatility(
  request: HestonPriceRequest,
): BlackScholesImpliedVolatilityResult {
  validateClosedRequest('hestonImpliedVolatility', request, HESTON_IV_SPEC, {
    argumentName: 'request',
    subject: true,
    exampleCall: HESTON_EXAMPLE,
  });
  const { type, input, parameters, options: options = {} } = request;
  ensureEnum(type, ['call', 'put'] as const, 'type', 'hestonImpliedVolatility');
  requireArgumentObject('hestonImpliedVolatility', 'input', input);
  requireArgumentObject('hestonImpliedVolatility', 'parameters', parameters);
  requireOptionalArgObject('hestonImpliedVolatility', 'options', options);
  requireHestonCosineTermCount('hestonImpliedVolatility', options.terms);
  const q = input.dividendYield ?? 0;
  const price = hestonPrice({
    type,
    input,
    parameters,
    options: { ...options, greeks: false },
  }).value;
  return blackScholesImpliedVolatility({
    type,
    price,
    spot: input.spot,
    strike: input.strike,
    timeToExpiryYears: input.timeToExpiryYears,
    riskFreeRate: input.riskFreeRate,
    dividendYield: q,
  });
}

/** One QE-scheme terminal price from `2·steps` standard normals (Andersen 2008). */
function qeTerminal(input: {
  shocks: number[];
  spot: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  parameters: HestonParameters;
  steps: number;
}): number {
  const {
    shocks: z,
    spot: S0,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    parameters: p,
    steps,
  } = input;
  const { v0, kappa, theta, sigma, rho } = p;
  const timeStepYears = T / steps;
  const ekt = Math.exp(-kappa * timeStepYears);
  const psiC = 1.5;
  const g1 = 0.5;
  const g2 = 0.5;
  const K0 = (-rho * kappa * theta * timeStepYears) / sigma;
  const K1 = g1 * timeStepYears * ((kappa * rho) / sigma - 0.5) - rho / sigma;
  const K2 = g2 * timeStepYears * ((kappa * rho) / sigma - 0.5) + rho / sigma;
  const K3 = g1 * timeStepYears * (1 - rho * rho);
  const K4 = g2 * timeStepYears * (1 - rho * rho);

  let v = v0;
  let x = Math.log(S0);
  for (let k = 0; k < steps; k++) {
    const zv = z[2 * k]!;
    const zs = z[2 * k + 1]!;
    const m = theta + (v - theta) * ekt;
    let vNext: number;
    if (m <= 0) {
      vNext = 0;
    } else {
      const s2 =
        (v * sigma * sigma * ekt * (1 - ekt)) / kappa +
        (theta * sigma * sigma * (1 - ekt) * (1 - ekt)) / (2 * kappa);
      const psiv = s2 / (m * m);
      if (psiv <= psiC) {
        const c1 = 2 / psiv;
        const b2 = c1 - 1 + Math.sqrt(c1) * Math.sqrt(Math.max(0, c1 - 1));
        const bb = Math.sqrt(b2);
        const aa = m / (1 + b2);
        vNext = aa * (bb + zv) * (bb + zv);
      } else {
        const pp = (psiv - 1) / (psiv + 1);
        const beta = (1 - pp) / m;
        const u = normalCdf(zv);
        vNext = u <= pp ? 0 : Math.log((1 - pp) / (1 - u)) / beta;
      }
    }
    x +=
      (r - q) * timeStepYears +
      K0 +
      K1 * v +
      K2 * vNext +
      Math.sqrt(Math.max(0, K3 * v + K4 * vNext)) * zs;
    v = vNext;
  }
  return Math.exp(x);
}

/**
 * Low-level kernel: Heston QE Monte-Carlo estimate of the discounted European payoff.
 *
 * Expert kernel form (model-subpath surface) — the curated root surface is {@link heston.monteCarloEstimate}.
 */
export function hestonMonteCarloEstimate(input: HestonMonteCarloEstimateInput): MonteCarloEstimate {
  validateClosedRequest('hestonMonteCarloEstimate', input, HESTON_MC_ESTIMATE_SPEC, {
    exampleCall: HESTON_EXAMPLE,
  });
  const {
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    parameters,
    options,
  } = input;
  // `type` is a meaning-changing string: unvalidated garbage would silently price the other leg.
  ensureEnum(type, ['call', 'put'] as const, 'type', 'hestonMonteCarloEstimate');
  requireArgumentObject('hestonMonteCarloEstimate', 'parameters', parameters);
  requireArgumentObject('hestonMonteCarloEstimate', 'options', options);
  const steps = options.steps ?? 64;
  const df = Math.exp(-r * T);
  const payoff = (z: number[]): number => {
    const ST = qeTerminal({
      shocks: z,
      spot: S,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
      parameters,
      steps,
    });
    return df * (type === 'call' ? Math.max(ST - K, 0) : Math.max(K - ST, 0));
  };
  const control = {
    estimate: (z: number[]) =>
      df *
      qeTerminal({
        shocks: z,
        spot: S,
        timeToExpiryYears: T,
        riskFreeRate: r,
        dividendYield: q,
        parameters,
        steps,
      }),
    mean: S * Math.exp(-q * T),
  };
  return monteCarloEstimate({
    dimensions: 2 * steps,
    payoff,
    options,
    controlVariate: control,
    label: 'hestonMonteCarloPrice',
  });
}

/**
 * Price a European option under Heston by QE Monte-Carlo, returning value + MC stats.
 *
 * Expert kernel form (model-subpath surface) — the curated root surface is {@link heston.monteCarloPrice}.
 */
export function hestonMonteCarloPrice(
  request: HestonPriceMonteCarloRequest,
): HestonMonteCarloResult {
  validateClosedRequest('hestonMonteCarloPrice', request, HESTON_MC_PRICE_SPEC, {
    argumentName: 'request',
    subject: true,
    exampleCall: HESTON_EXAMPLE,
  });
  const { type, input, parameters, options } = request;
  const functionName = 'hestonMonteCarloPrice';
  ensureEnum(type, ['call', 'put'] as const, 'type', functionName);
  requireArgumentObject(functionName, 'input', input);
  requireArgumentObject(functionName, 'parameters', parameters);
  requireArgumentObject(functionName, 'options', options);
  ensurePositive(input.spot, 'spot', functionName);
  ensurePositive(input.strike, 'strike', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
  const q = input.dividendYield ?? 0;
  ensureFinite(q, 'dividendYield', functionName);
  const warnings = validateParams(parameters, functionName);

  const est = hestonMonteCarloEstimate({
    type,
    spot: input.spot,
    strike: input.strike,
    timeToExpiryYears: input.timeToExpiryYears,
    riskFreeRate: input.riskFreeRate,
    dividendYield: q,
    parameters,
    options,
  });
  const diagnostics: Diagnostics = {
    engine: 'heston',
    method: est.method === 'pseudo' ? 'qe-monte-carlo' : `qe-monte-carlo-${est.method}`,
    converged: est.converged,
    iterations: est.paths,
    // The QE Monte-Carlo path does not compute Greeks — report their ABSENCE, never fabricate zeros.
    warnings: [
      ...warnings,
      ...est.warnings,
      {
        code: WarningCode.GreeksNotComputed,
        message: 'The Heston QE Monte-Carlo engine does not compute Greeks.',
        severity: 'info' as const,
      },
    ],
  };
  // Same structural bound as the analytic path, with the estimator's own sampling error as slack.
  assertNoArbitrageBounds({
    engine: 'heston-qe-mc',
    type,
    style: 'european',
    value: est.value,
    underlyingPresentValue: input.spot * Math.exp(-q * input.timeToExpiryYears),
    strikePresentValue: input.strike * Math.exp(-input.riskFreeRate * input.timeToExpiryYears),
    spot: input.spot,
    strike: input.strike,
    tolerance:
      5 *
      (est.standardError !== null && Number.isFinite(est.standardError) ? est.standardError : 0),
  });
  return {
    value: est.value,
    assumptions: assumptions(input.timeToExpiryYears, q, 'heston-qe-mc'),
    diagnostics,
    monteCarlo: {
      standardError: est.standardError,
      confidenceInterval: est.confidenceInterval,
      paths: est.paths,
      seed: est.seed,
      method: est.method,
      varianceReduction: est.varianceReduction,
    },
  };
}

/**
 * The Heston model namespace — the grouped, discoverable surface over the flat `heston*` functions.
 * `heston.price` / `heston.monteCarloPrice` / `heston.cosineExpansion` / `heston.impliedVolatility` / `heston.monteCarloEstimate` are the
 * same functions; prefer the namespace over the deprecated flat exports.
 */
export const heston = {
  price: hestonPrice,
  monteCarloPrice: hestonMonteCarloPrice,
  cosineExpansion: hestonCosineExpansionPrice,
  impliedVolatility: hestonImpliedVolatility,
  monteCarloEstimate: hestonMonteCarloEstimate,
} as const;
