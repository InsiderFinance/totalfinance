/**
 * Closed-form American approximations (spec §9.3):
 *   - Barone–Adesi–Whaley (1987) quadratic approximation;
 *   - Bjerksund–Stensland (1993) single-boundary approximation;
 *   - Bjerksund–Stensland (2002) two-boundary refinement — splits time to expiry at
 *     `t₁ = ½(√5 − 1)T` and uses two flat exercise boundaries, evaluated with the cumulative
 *     bivariate normal. This is the more accurate, more widely-used form (the default alias).
 *
 * All use the carry rate `b = r − q` and reuse the BSM European price. They are validated against
 * the lattice engines (the convergence reference) and an external benchmark in tests.
 */

import { ErrorCode, type OptionType, UnsupportedError } from '@totalfinance/core';
import { normalCdf, normalPdf } from '@totalfinance/math';
import { blackScholesPrice } from '../bsm.js';
import { vanillaIntrinsicUnchecked } from '../payoff-kernel.js';
import type { AmericanApproximationInput } from './scalar-pricing.js';

interface CarryOptionInput {
  type: OptionType;
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  carryRate: number;
  volatility: number;
}

type CarryCallInput = Omit<CarryOptionInput, 'type'>;

interface BawCriticalInput {
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  carryRate: number;
  volatility: number;
}

/** European price parameterized by carry `b` (= r − q). */
function euro(input: CarryOptionInput): number {
  const {
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    carryRate: b,
    volatility: sigma,
  } = input;
  return blackScholesPrice({
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: r - b,
    volatility: sigma,
  });
}

// ---- Barone–Adesi–Whaley ----

/** A converged critical (early-exercise) spot, with the Newton iteration's own verdict. */
interface BawCritical {
  spot: number;
  converged: boolean;
  iterations: number;
}

/** Maximum Newton steps for the BAW critical price; the residual tolerance is 1e-8 of the strike. */
const BAW_MAX_ITERATIONS = 100;

/**
 * Barone–Adesi–Whaley is a **positive-rate** approximation.
 *
 * Its quadratic term divides by `Kdisc = 1 − e^{−rT}`, which is exactly 0 at `r = 0` (the exponent
 * `q₂` becomes 0/0 → NaN) and changes sign for `r < 0`, where the branch the derivation assumed to be
 * the early-exercise root diverges. Both used to be returned as a number under a hardcoded
 * `converged: true`.
 *
 * One case at `r ≤ 0` is not an approximation problem at all and is answered EXACTLY instead of
 * refused: with `r ≤ 0` and `q ≥ 0` an American PUT is never exercised early — holding is worth at
 * least `K·e^{−rτ} − S·e^{−qτ} ≥ K − S`, the immediate exercise value — so its value is the European
 * put. Every other `r ≤ 0` combination (any call, or a put under a negative dividend yield, where
 * that dominance argument fails) is a typed refusal naming the engines that DO handle the regime.
 */
function rateRegimeVerdict(input: AmericanApproximationInput): 'price' | 'european' {
  const { riskFreeRate: r, dividendYield: q, type, timeToExpiryYears: T } = input;
  if (r > 0) return 'price';
  if (type === 'put' && q >= 0) return 'european';
  throw new UnsupportedError(
    `barone-adesi-whaley: the quadratic approximation is undefined at riskFreeRate ≤ 0 (got ${r}) for this ` +
      `${type} — its critical-price exponent divides by 1 − e^{−rT}, which is 0 at r = 0 and changes sign for ` +
      'r < 0, so the formula returns NaN or a diverging value rather than a price. Use ' +
      'engines.bjerksundStensland2002() (valid at any rate) or a lattice — ' +
      "engines.binomial({ variant: 'leisen-reimer', steps: 501 }) — for this contract. (A put with " +
      'riskFreeRate ≤ 0 and a non-negative dividendYield is priced exactly, as its European value: early ' +
      'exercise is never optimal there.)',
    {
      code: ErrorCode.EngineUnsupportedContract,
      context: {
        engine: 'barone-adesi-whaley',
        riskFreeRate: r,
        dividendYield: q,
        type,
        timeToExpiryYears: T,
      },
    },
  );
}

function bawCallCritical(input: BawCriticalInput): BawCritical {
  const {
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    carryRate: b,
    volatility: sigma,
  } = input;
  const sig2 = sigma * sigma;
  const sqrtT = Math.sqrt(T);
  const N = (2 * b) / sig2;
  const M = (2 * r) / sig2;
  const q2u = (-(N - 1) + Math.sqrt((N - 1) ** 2 + 4 * M)) / 2;
  const Su = K / (1 - 1 / q2u);
  const h2 = -(b * T + 2 * sigma * sqrtT) * (K / (Su - K));
  let Si = K + (Su - K) * (1 - Math.exp(h2));
  const Kdisc = 1 - Math.exp(-r * T);
  const q2 = (-(N - 1) + Math.sqrt((N - 1) ** 2 + (4 * M) / Kdisc)) / 2;
  let converged = false;
  let iterations = 0;

  for (let iter = 0; iter < BAW_MAX_ITERATIONS; iter++) {
    iterations = iter + 1;
    const d1 = (Math.log(Si / K) + (b + 0.5 * sig2) * T) / (sigma * sqrtT);
    const c = euro({
      type: 'call',
      spot: Si,
      strike: K,
      timeToExpiryYears: T,
      riskFreeRate: r,
      carryRate: b,
      volatility: sigma,
    });
    const lhs = Si - K;
    const rhs = c + ((1 - Math.exp((b - r) * T) * normalCdf(d1)) * Si) / q2;
    const bi =
      Math.exp((b - r) * T) * normalCdf(d1) * (1 - 1 / q2) +
      (1 - (Math.exp((b - r) * T) * normalPdf(d1)) / (sigma * sqrtT)) / q2;
    if (Math.abs(lhs - rhs) / K <= 1e-8) {
      converged = true;
      break;
    }
    Si = (K + rhs - bi * Si) / (1 - bi);
  }
  return { spot: Si, converged, iterations };
}

function bawPutCritical(input: BawCriticalInput): BawCritical {
  const {
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    carryRate: b,
    volatility: sigma,
  } = input;
  const sig2 = sigma * sigma;
  const sqrtT = Math.sqrt(T);
  const N = (2 * b) / sig2;
  const M = (2 * r) / sig2;
  const q1u = (-(N - 1) - Math.sqrt((N - 1) ** 2 + 4 * M)) / 2;
  const Su = K / (1 - 1 / q1u);
  const h1 = (b * T - 2 * sigma * sqrtT) * (K / (K - Su));
  let Si = Su + (K - Su) * Math.exp(h1);
  const Kdisc = 1 - Math.exp(-r * T);
  const q1 = (-(N - 1) - Math.sqrt((N - 1) ** 2 + (4 * M) / Kdisc)) / 2;
  let converged = false;
  let iterations = 0;

  for (let iter = 0; iter < BAW_MAX_ITERATIONS; iter++) {
    iterations = iter + 1;
    const d1 = (Math.log(Si / K) + (b + 0.5 * sig2) * T) / (sigma * sqrtT);
    const p = euro({
      type: 'put',
      spot: Si,
      strike: K,
      timeToExpiryYears: T,
      riskFreeRate: r,
      carryRate: b,
      volatility: sigma,
    });
    const lhs = K - Si;
    const rhs = p - ((1 - Math.exp((b - r) * T) * normalCdf(-d1)) * Si) / q1;
    const bi =
      -Math.exp((b - r) * T) * normalCdf(-d1) * (1 - 1 / q1) -
      (1 + (Math.exp((b - r) * T) * normalPdf(-d1)) / (sigma * sqrtT)) / q1;
    if (Math.abs(lhs - rhs) / K <= 1e-8) {
      converged = true;
      break;
    }
    Si = (K - rhs + bi * Si) / (1 + bi);
  }
  return { spot: Si, converged, iterations };
}

/** A BAW price with the critical-price iteration's own convergence verdict (never assumed). */
export interface BawSolution {
  value: number;
  /** `false` when the critical-price Newton loop hit its budget without meeting tolerance. */
  converged: boolean;
  /** Newton steps taken (0 when the closed European branch answered without iterating). */
  iterations: number;
}

/** Barone–Adesi–Whaley American price with diagnostics (the form the engine adapter uses). */
export function bawSolve(input: AmericanApproximationInput): BawSolution {
  const verdict = rateRegimeVerdict(input);
  const {
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
  } = input;
  const b = r - q;
  const sig2 = sigma * sigma;
  const sqrtT = Math.sqrt(T);
  const Kdisc = 1 - Math.exp(-r * T);

  if (verdict === 'european') {
    // r ≤ 0 with q ≥ 0: an American put is never exercised early, so this is exact.
    return {
      value: euro({
        type,
        spot: S,
        strike: K,
        timeToExpiryYears: T,
        riskFreeRate: r,
        carryRate: b,
        volatility: sigma,
      }),
      converged: true,
      iterations: 0,
    };
  }

  if (type === 'call') {
    if (b >= r) {
      // Never optimal to exercise early: the European price is exact, not an approximation.
      return {
        value: euro({
          type: 'call',
          spot: S,
          strike: K,
          timeToExpiryYears: T,
          riskFreeRate: r,
          carryRate: b,
          volatility: sigma,
        }),
        converged: true,
        iterations: 0,
      };
    }
    const critical = bawCallCritical({
      strike: K,
      timeToExpiryYears: T,
      riskFreeRate: r,
      carryRate: b,
      volatility: sigma,
    });
    const Sstar = critical.spot;
    const solution = (value: number): BawSolution => ({
      value,
      converged: critical.converged,
      iterations: critical.iterations,
    });
    if (S >= Sstar) return solution(S - K);
    const N = (2 * b) / sig2;
    const M = (2 * r) / sig2;
    const q2 = (-(N - 1) + Math.sqrt((N - 1) ** 2 + (4 * M) / Kdisc)) / 2;
    const d1 = (Math.log(Sstar / K) + (b + 0.5 * sig2) * T) / (sigma * sqrtT);
    const A2 = (Sstar / q2) * (1 - Math.exp((b - r) * T) * normalCdf(d1));
    return solution(
      euro({
        type: 'call',
        spot: S,
        strike: K,
        timeToExpiryYears: T,
        riskFreeRate: r,
        carryRate: b,
        volatility: sigma,
      }) +
        A2 * (S / Sstar) ** q2,
    );
  }

  const critical = bawPutCritical({
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    carryRate: b,
    volatility: sigma,
  });
  const Sstar = critical.spot;
  const solution = (value: number): BawSolution => ({
    value,
    converged: critical.converged,
    iterations: critical.iterations,
  });
  if (S <= Sstar) return solution(K - S);
  const N = (2 * b) / sig2;
  const M = (2 * r) / sig2;
  const q1 = (-(N - 1) - Math.sqrt((N - 1) ** 2 + (4 * M) / Kdisc)) / 2;
  const d1 = (Math.log(Sstar / K) + (b + 0.5 * sig2) * T) / (sigma * sqrtT);
  const A1 = -(Sstar / q1) * (1 - Math.exp((b - r) * T) * normalCdf(-d1));
  return solution(
    euro({
      type: 'put',
      spot: S,
      strike: K,
      timeToExpiryYears: T,
      riskFreeRate: r,
      carryRate: b,
      volatility: sigma,
    }) +
      A1 * (S / Sstar) ** q1,
  );
}

/** Barone–Adesi–Whaley American option price. */
export function bawPrice(input: AmericanApproximationInput): number {
  return bawSolve(input).value;
}

// ---- Bjerksund–Stensland: stable evaluation shared by the 1993 and 2002 forms ----
//
// Both forms are sums of terms `coefficient · e^{λT}·S^γ · [probability − (I/S)^κ · probability]`.
// Each reflected product `(I/S)^κ·N(·)` (or `·M(·,·,ρ)`) is a reflection-principle probability
// bounded by one, with `κ = 2μ/σ²` for the drift `μ = b + (γ − ½)σ²`. At a low volatility, or with a
// boundary far from the spot, `κ` reaches the hundreds or thousands: the power overflows to Infinity
// while its matching CDF underflows to 0. The textbook product is then `Infinity · 0 = NaN`, although the
// true term is representable (usually 0, sometimes O(1)). The same happens to `α = (I − K)·I^{−β}` times
// `S^β`, which is bounded by S. Every such product is therefore formed in the log domain: the power's
// logarithm is folded into the exponent of each additive piece of the CDF, so neither factor is
// formed separately. This is an exact algebraic rearrangement, not a clamp. Terms are the paper's terms,
// in the paper's order, and ordinary inputs agree with the direct products to rounding.
//
// The boundary algebra is rewritten for the same reason. `β − 1`, `B∞ − B0` and `1 − e^{h}` are
// differences of nearly equal numbers at low volatility or as b → r. Each one has a closed form that
// does not subtract (see `callBoundaryTerms`). `λ = −r + γb + ½γ(γ − 1)σ²` is exactly 0 at γ = β,
// because β is defined as the root of that expression. It is used as 0 rather than recomputed from
// terms of size b²/σ².

const LOG_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);
const FOUR_PI = 4 * Math.PI;

/**
 * `ln Φ(x)` with full relative accuracy on the whole real line.
 *
 * For x ≥ −2, `normalCdf` (West 2009) is relatively accurate (≤ 1e-15). Further left, its rational
 * and continued-fraction forms are accurate only in ABSOLUTE terms: the relative error reaches 5e-11
 * at x = −5 and 9e-9 near x = −8. That is harmless for a probability, but here the tail is
 * multiplied by a reflection weight that can exceed e^{+700}, so its relative error becomes the
 * price's. Below −2, the Mills ratio `R(z) = Φ(−z)/φ(z)` comes from its continued fraction
 * (DLMF 7.9.3, the same expansion `analytic-premium.ts` uses). It is evaluated by backward
 * recurrence over `⌈320/z²⌉ + 8` levels (88 at z = 2, 21 at z = 5, 9 beyond z ≈ 18), seeded with
 * its own asymptotic tail `tₙ ≈ (√(z² + 4n) − z)/2` rather than 0. Checked against mpmath on a
 * dense grid of z ∈ [2, 80), it stays within 1.3 ulp of `ln Φ` (that residue is the rounding of
 * z²/2 itself). It stays finite where Φ underflows.
 */
export function logNormalCdf(x: number): number {
  if (x >= -2) return Math.log(normalCdf(x));
  const z = -x;
  const levels = Math.ceil(320 / (z * z)) + 8;
  let tail = (Math.sqrt(z * z + 4 * (levels + 1)) - z) / 2;
  for (let k = levels; k >= 1; k--) tail = k / (z + tail);
  return -0.5 * z * z - LOG_SQRT_2PI - Math.log(z + tail);
}

// Genz (2004) BVU Gauss–Legendre half-nodes and weights for 0.75 ≤ |ρ| < 0.925: the same 20-point rule
// `bivariateNormalCdf` (@totalfinance/math) uses at the Bjerksund–Stensland 2002 correlation
// ρ = ±√(t₁/T) = ±√(½(√5 − 1)) ≈ ±0.786.
const GL20_X = [
  0.9931285991850949, 0.9639719272779138, 0.9122344282513259, 0.8391169718222188,
  0.7463319064601508, 0.636053680726515, 0.5108670019508271, 0.3737060887154196, 0.2277858511416451,
  0.07652652113349733,
] as const;
const GL20_W = [
  0.01761400713915212, 0.04060142980038694, 0.06267204833410906, 0.08327674157670475,
  0.1019301198172404, 0.1181945319615184, 0.1316886384491766, 0.1420961093183821,
  0.1491729864726037, 0.1527533871307259,
] as const;

export interface WeightedBivariateInput {
  /** Upper integration limit of the first standard normal coordinate. */
  firstLimit: number;
  /** Upper integration limit of the second standard normal coordinate. */
  secondLimit: number;
  /** Correlation, in the 20-point Genz regime 0.75 ≤ |ρ| < 0.925 (here always ±0.786). */
  correlation: number;
  /** Natural log of the non-negative weight; the weight itself may lie far outside binary64 range. */
  logWeight: number;
}

/**
 * `e^{logWeight} · M(a, b; ρ)`, where `M` is the cumulative bivariate normal. The weight and the
 * probability are never formed separately.
 *
 * In Genz's BVU form for |ρ| < 0.925, `M(a, b; ρ) = Φ(a)Φ(b) + (asin ρ / 4π) · Σ wᵢ e^{Eᵢ}`, where each
 * `Eᵢ = (sᵢab − (a² + b²)/2)/(1 − sᵢ²)` and `sᵢ` is the sine of a quadrature node. The weight's
 * logarithm is added to every exponent, and to `ln Φ(a) + ln Φ(b)`. So each additive piece is the
 * weighted value itself. This is the same quadrature as `bivariateNormalCdf`, including its `≥ 0`
 * clamp of rounding (the `≤ 1` clamp scales to `≤ e^{logWeight}`; a non-finite sum is never clamped), and the same rule and nodes. It
 * only moves the multiplication into the exponents.
 */
export function weightedBivariateNormalCdf(input: WeightedBivariateInput): number {
  const { firstLimit: a, secondLimit: b, correlation: rho, logWeight } = input;
  const ab = a * b;
  const halfSumSquares = (a * a + b * b) / 2;
  const asr = Math.asin(rho);
  let sum = 0;
  for (let i = 0; i < GL20_X.length; i++) {
    for (let side = -1; side <= 1; side += 2) {
      const sn = Math.sin((asr * (side * GL20_X[i]! + 1)) / 2);
      sum += GL20_W[i]! * Math.exp((sn * ab - halfSumSquares) / (1 - sn * sn) + logWeight);
    }
  }
  const p = (sum * asr) / FOUR_PI + Math.exp(logWeight + logNormalCdf(a) + logNormalCdf(b));
  // The clamps absorb rounding only. A non-finite sum is a failure, never a bound to substitute: it
  // propagates so the engine's postcondition refuses the price.
  if (!Number.isFinite(p)) return p;
  if (p < 0) return 0;
  const ceiling = Math.exp(logWeight);
  return p > ceiling ? ceiling : p;
}

/** The γ-specific constants of φ and Ψ: `κ = 2b/σ² + 2γ − 1` and the drift `μ = b + (γ − ½)σ²`. */
interface ReflectionConstants {
  kappa: number;
  drift: number;
}

interface WeightedPhiInput extends ReflectionConstants {
  spot: number;
  timeToExpiryYears: number;
  trigger: number;
  boundary: number;
  volatility: number;
  /** `ln` of the positive factor multiplying the bracket (e.g. `λT`, or `β·ln(S/I)` at γ = β). */
  logWeight: number;
}

/** `e^{logWeight} · [Φ(d) − (I/S)^κ·Φ(d − 2 ln(I/S)/(σ√T))]`: the paper's φ bracket, weighted. */
function weightedPhiBracket(input: WeightedPhiInput): number {
  const {
    spot: S,
    timeToExpiryYears: T,
    trigger: H,
    boundary: I,
    volatility: sigma,
    kappa,
    drift,
    logWeight,
  } = input;
  const sigmaRootT = sigma * Math.sqrt(T);
  const logBoundaryRatio = Math.log(I / S);
  const d = -(Math.log(S / H) + drift * T) / sigmaRootT;
  return (
    Math.exp(logWeight + logNormalCdf(d)) -
    Math.exp(
      logWeight + kappa * logBoundaryRatio + logNormalCdf(d - (2 * logBoundaryRatio) / sigmaRootT),
    )
  );
}

interface WeightedPsiInput extends ReflectionConstants {
  spot: number;
  timeToExpiryYears: number;
  firstPeriod: number;
  trigger: number;
  secondBoundary: number;
  firstBoundary: number;
  volatility: number;
  /** `ln` of the positive factor multiplying the bracket. */
  logWeight: number;
}

/**
 * The Ψ ("ksi") bracket of the 2002 model, weighted: a two-period extension of φ over `[0, t1]` and
 * `[0, T]` with boundary `I1` on the first leg and `I2` on the second. It is evaluated with the
 * cumulative bivariate normal at correlation `√(t1/T)`, and each reflected power is folded into its
 * own weighted bivariate term.
 */
function weightedPsiBracket(input: WeightedPsiInput): number {
  const {
    spot: S,
    timeToExpiryYears: T2,
    firstPeriod: t1,
    trigger: H,
    secondBoundary: I2,
    firstBoundary: I1,
    volatility: sigma,
    kappa,
    drift,
    logWeight,
  } = input;
  const sigmaRoot1 = sigma * Math.sqrt(t1);
  const sigmaRoot2 = sigma * Math.sqrt(T2);

  // The paper's ratios of products (I2²/(S·I1), S·I1²/(H·I2²), …) are formed as products of ratios,
  // each O(1): the products themselves overflow above a spot near 1e103 and underflow below 1e-148,
  // while the ratios are scale-free (homogeneity of degree zero).
  const e1 = (Math.log(S / I1) + drift * t1) / sigmaRoot1;
  const e2 = (Math.log((I2 / S) * (I2 / I1)) + drift * t1) / sigmaRoot1;
  const e3 = (Math.log(S / I1) - drift * t1) / sigmaRoot1;
  const e4 = (Math.log((I2 / S) * (I2 / I1)) - drift * t1) / sigmaRoot1;

  const f1 = (Math.log(S / H) + drift * T2) / sigmaRoot2;
  const f2 = (Math.log((I2 / S) * (I2 / H)) + drift * T2) / sigmaRoot2;
  const f3 = (Math.log((I1 / S) * (I1 / H)) + drift * T2) / sigmaRoot2;
  const f4 = (Math.log((S / H) * (I1 / I2) * (I1 / I2)) + drift * T2) / sigmaRoot2;

  const rho = Math.sqrt(t1 / T2);
  // Each term's own reflection power multiplies the bracket's weight: fold its log into the weight.
  const term = (input: WeightedBivariateInput): number =>
    weightedBivariateNormalCdf({ ...input, logWeight: logWeight + input.logWeight });

  return (
    term({ firstLimit: -e1, secondLimit: -f1, correlation: rho, logWeight: 0 }) -
    term({
      firstLimit: -e2,
      secondLimit: -f2,
      correlation: rho,
      logWeight: kappa * Math.log(I2 / S),
    }) -
    term({
      firstLimit: -e3,
      secondLimit: -f3,
      correlation: -rho,
      logWeight: kappa * Math.log(I1 / S),
    }) +
    term({
      firstLimit: -e4,
      secondLimit: -f4,
      correlation: -rho,
      logWeight: kappa * Math.log(I1 / I2),
    })
  );
}

interface BoundaryCarryInput {
  strike: number;
  riskFreeRate: number;
  carryRate: number;
  volatility: number;
}

/**
 * Boundary constants shared by both forms, computed WITHOUT subtracting nearly equal numbers (b < r).
 *
 * - `u = β − 1` is the positive root of `½σ²u² + (½σ² + b)u − (r − b) = 0`, which is the β quadratic
 *   shifted by one. The textbook `½ − b/σ² + √((b/σ² − ½)² + 2r/σ²) − 1` subtracts two numbers of size
 *   |b|/σ². Here the root is taken in whichever algebraic form adds same-signed quantities.
 * - `B0 − K = max(b, 0)·K/(r − b)`. This is `max(K, rK/(r − b)) − K`, and `r/(r − b) > 1` exactly when
 *   b > 0.
 * - `B∞ − B0` is `K/u` when b ≤ 0 (B0 = K). When b > 0, the quadratic gives
 *   `(r − b) − bu = ½σ²u(u + 1)`, so `B∞ − B0 = K/u − bK/(r − b) = Kσ²(1 + u)/(2(r − b))`. The textbook
 *   difference of two O(K·r/(r − b)) boundaries loses its relative accuracy as σ → 0 or b → r.
 */
function callBoundaryTerms(input: BoundaryCarryInput): {
  betaMinusOne: number;
  expiryExcess: number;
  boundaryGap: number;
} {
  const { strike: K, riskFreeRate: r, carryRate: b, volatility: sigma } = input;
  const sig2 = sigma * sigma;
  const linear = 0.5 * sig2 + b;
  const carryGap = r - b;
  const root = Math.sqrt(linear * linear + 2 * sig2 * carryGap);
  const betaMinusOne = linear >= 0 ? (2 * carryGap) / (linear + root) : (root - linear) / sig2;
  return {
    betaMinusOne,
    expiryExcess: b > 0 ? (b * K) / carryGap : 0,
    boundaryGap: b > 0 ? (K * sig2 * (1 + betaMinusOne)) / (2 * carryGap) : K / betaMinusOne,
  };
}

/** Reflection constants at γ = β (via `u = β − 1`), γ = 1 and γ = 0. */
function reflectionConstants(input: {
  carryRate: number;
  volatility: number;
  betaMinusOne: number;
}): { beta: ReflectionConstants; one: ReflectionConstants; zero: ReflectionConstants } {
  const { carryRate: b, volatility: sigma, betaMinusOne: u } = input;
  const sig2 = sigma * sigma;
  const carryRatio = (2 * b) / sig2;
  return {
    beta: { kappa: carryRatio + 1 + 2 * u, drift: b + (u + 0.5) * sig2 },
    one: { kappa: carryRatio + 1, drift: b + 0.5 * sig2 },
    zero: { kappa: carryRatio - 1, drift: b - 0.5 * sig2 },
  };
}

// ---- Bjerksund–Stensland (1993) ----

function bsCall(input: CarryCallInput): number {
  const {
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    carryRate: b,
    volatility: sigma,
  } = input;
  if (b >= r) return euro({ type: 'call', ...input });
  const { betaMinusOne, expiryExcess, boundaryGap } = callBoundaryTerms({
    strike: K,
    riskFreeRate: r,
    carryRate: b,
    volatility: sigma,
  });
  const beta = 1 + betaMinusOne;
  const b0 = K + expiryExcess;
  // h(T) = −(bT + 2σ√T)·B0/(B∞ − B0);  I − K = (B0 − K) + (B∞ − B0)(1 − e^{h}).
  const ht = -(b * T + 2 * sigma * Math.sqrt(T)) * (b0 / boundaryGap);
  const excess = expiryExcess + boundaryGap * -Math.expm1(ht);
  const I = K + excess;
  if (S >= I) return S - K;
  const gammas = reflectionConstants({ carryRate: b, volatility: sigma, betaMinusOne });
  const phiAt = (constants: ReflectionConstants, trigger: number, logWeight: number): number =>
    weightedPhiBracket({
      spot: S,
      timeToExpiryYears: T,
      trigger,
      boundary: I,
      volatility: sigma,
      ...constants,
      logWeight,
    });
  // α·S^β = (I − K)·(S/I)^β, and α·φ(γ = β) carries the same factor with λ = 0.
  const logAlphaWeight = beta * Math.log(S / I);
  const spotDiscount = -(r - b) * T;
  const strikeDiscount = -r * T;
  return (
    excess * Math.exp(logAlphaWeight) -
    excess * phiAt(gammas.beta, I, logAlphaWeight) +
    S * phiAt(gammas.one, I, spotDiscount) -
    S * phiAt(gammas.one, K, spotDiscount) -
    K * phiAt(gammas.zero, I, strikeDiscount) +
    K * phiAt(gammas.zero, K, strikeDiscount)
  );
}

/**
 * The floor every Bjerksund–Stensland value must respect.
 *
 * Both forms are LOWER bounds on the American value (they exercise on a flat boundary, which is
 * suboptimal), and an American option is worth at least the larger of its intrinsic value and its
 * European counterpart. Below that floor the closed form is simply out of its accurate region — and
 * it can go badly wrong there: the put–call transformation's early-exercise branch returns the
 * TRANSFORMED call's `S − K`, which for an out-of-the-money put at a low volatility is the negative
 * number `K − S` (a −5 for S=105, K=100, σ ≤ 1%). Taking the tighter of the two bounds keeps the
 * approximation a lower bound — the property its accuracy tests pin — while making a negative
 * "price" structurally impossible.
 */
function americanFloor(input: AmericanApproximationInput, approximation: number): number {
  const {
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
  } = input;
  const intrinsic = vanillaIntrinsicUnchecked({ type, underlyingPrice: S, strike: K });
  const european = blackScholesPrice({
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
  });
  return Math.max(approximation, intrinsic, european);
}

/**
 * The raw Bjerksund–Stensland (1993) approximation, BEFORE {@link americanFloor}. It is exported for
 * the reference tests, which must see the closed form itself and not the floor that can mask it.
 */
export function bjerksundStensland1993Approximation(input: AmericanApproximationInput): number {
  const {
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility,
  } = input;
  const b = r - q;
  return type === 'call'
    ? bsCall({
        spot: S,
        strike: K,
        timeToExpiryYears: T,
        riskFreeRate: r,
        carryRate: b,
        volatility,
      })
    : // put–call transformation: P(S,K,T,r,b,σ) = C(K,S,T,r−b,−b,σ)
      bsCall({
        spot: K,
        strike: S,
        timeToExpiryYears: T,
        riskFreeRate: r - b,
        carryRate: -b,
        volatility,
      });
}

/** Bjerksund–Stensland (1993) American option price. */
export function bjerksundStenslandPrice(input: AmericanApproximationInput): number {
  return americanFloor(input, bjerksundStensland1993Approximation(input));
}

// ---- Bjerksund–Stensland (2002) ----

function bs2002Call(input: CarryCallInput): number {
  const {
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    carryRate: b,
    volatility: sigma,
  } = input;
  if (b >= r) return euro({ type: 'call', ...input }); // never optimal to exercise early
  const { betaMinusOne, expiryExcess, boundaryGap } = callBoundaryTerms({
    strike: K,
    riskFreeRate: r,
    carryRate: b,
    volatility: sigma,
  });
  const beta = 1 + betaMinusOne;
  const b0 = K + expiryExcess;
  const t1 = 0.5 * (Math.sqrt(5) - 1) * T;
  // h(t) = −(bt + 2σ√t)·K²/((B∞ − B0)·B0);  I(t) − K = (B0 − K) + (B∞ − B0)(1 − e^{h(t)}).
  // K²/((B∞ − B0)·B0), formed as a product of ratios so it neither overflows nor underflows with scale.
  const boundaryScale = (K / boundaryGap) * (K / b0);
  const excessAt = (t: number): number =>
    expiryExcess + boundaryGap * -Math.expm1(-(b * t + 2 * sigma * Math.sqrt(t)) * boundaryScale);
  const excess1 = excessAt(t1);
  const excess2 = excessAt(T);
  const I1 = K + excess1;
  const I2 = K + excess2;
  if (S >= I2) return S - K;
  const gammas = reflectionConstants({ carryRate: b, volatility: sigma, betaMinusOne });
  const phiAt = (constants: ReflectionConstants, trigger: number, logWeight: number): number =>
    weightedPhiBracket({
      spot: S,
      timeToExpiryYears: t1,
      trigger,
      boundary: I2,
      volatility: sigma,
      ...constants,
      logWeight,
    });
  const psiAt = (constants: ReflectionConstants, trigger: number, logWeight: number): number =>
    weightedPsiBracket({
      spot: S,
      timeToExpiryYears: T,
      firstPeriod: t1,
      trigger,
      secondBoundary: I2,
      firstBoundary: I1,
      volatility: sigma,
      ...constants,
      logWeight,
    });
  // αⱼ·S^β = (Iⱼ − K)·(S/Iⱼ)^β, and αⱼ·φ/Ψ(γ = β) carry the same factor with λ = 0.
  const logAlpha1Weight = beta * Math.log(S / I1);
  const logAlpha2Weight = beta * Math.log(S / I2);
  const spotDiscount1 = -(r - b) * t1;
  const strikeDiscount1 = -r * t1;
  const spotDiscount2 = -(r - b) * T;
  const strikeDiscount2 = -r * T;

  return (
    excess2 * Math.exp(logAlpha2Weight) -
    excess2 * phiAt(gammas.beta, I2, logAlpha2Weight) +
    S * phiAt(gammas.one, I2, spotDiscount1) -
    S * phiAt(gammas.one, I1, spotDiscount1) -
    K * phiAt(gammas.zero, I2, strikeDiscount1) +
    K * phiAt(gammas.zero, I1, strikeDiscount1) +
    excess1 * phiAt(gammas.beta, I1, logAlpha1Weight) -
    excess1 * psiAt(gammas.beta, I1, logAlpha1Weight) +
    S * psiAt(gammas.one, I1, spotDiscount2) -
    S * psiAt(gammas.one, K, spotDiscount2) -
    K * psiAt(gammas.zero, I1, strikeDiscount2) +
    K * psiAt(gammas.zero, K, strikeDiscount2)
  );
}

/**
 * The raw Bjerksund–Stensland (2002) approximation, BEFORE {@link americanFloor}. It is exported for
 * the reference tests, which must see the closed form itself and not the floor that can mask it.
 */
export function bjerksundStensland2002Approximation(input: AmericanApproximationInput): number {
  const {
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility,
  } = input;
  const b = r - q;
  return type === 'call'
    ? bs2002Call({
        spot: S,
        strike: K,
        timeToExpiryYears: T,
        riskFreeRate: r,
        carryRate: b,
        volatility,
      })
    : // put–call transformation: P(S,K,T,r,b,σ) = C(K,S,T,r−b,−b,σ)
      bs2002Call({
        spot: K,
        strike: S,
        timeToExpiryYears: T,
        riskFreeRate: r - b,
        carryRate: -b,
        volatility,
      });
}

/** Bjerksund–Stensland (2002) American option price — the two-boundary refinement of the 1993 form. */
export function bjerksundStensland2002Price(input: AmericanApproximationInput): number {
  return americanFloor(input, bjerksundStensland2002Approximation(input));
}
