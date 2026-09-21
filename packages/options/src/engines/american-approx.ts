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
import { bivariateNormalCdf, normalCdf, normalPdf } from '@totalfinance/math';
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

interface PhiInput {
  spot: number;
  timeToExpiryYears: number;
  gamma: number;
  trigger: number;
  boundary: number;
  riskFreeRate: number;
  carryRate: number;
  volatility: number;
}

interface KsiInput {
  spot: number;
  timeToExpiryYears: number;
  gamma: number;
  trigger: number;
  secondBoundary: number;
  firstBoundary: number;
  firstPeriod: number;
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

// ---- Bjerksund–Stensland (1993) ----

function phi(input: PhiInput): number {
  const {
    spot: S,
    timeToExpiryYears: T,
    gamma,
    trigger: H,
    boundary: I,
    riskFreeRate: r,
    carryRate: b,
    volatility: sigma,
  } = input;
  const sig2 = sigma * sigma;
  const sqrtT = Math.sqrt(T);
  const lambda = (-r + gamma * b + 0.5 * gamma * (gamma - 1) * sig2) * T;
  const kappa = (2 * b) / sig2 + (2 * gamma - 1);
  const d = -(Math.log(S / H) + (b + (gamma - 0.5) * sig2) * T) / (sigma * sqrtT);
  return (
    Math.exp(lambda) *
    S ** gamma *
    (normalCdf(d) - (I / S) ** kappa * normalCdf(d - (2 * Math.log(I / S)) / (sigma * sqrtT)))
  );
}

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
  const sig2 = sigma * sigma;
  const beta = 0.5 - b / sig2 + Math.sqrt((b / sig2 - 0.5) ** 2 + (2 * r) / sig2);
  const bInf = (beta / (beta - 1)) * K;
  const b0 = Math.max(K, (r / (r - b)) * K);
  const ht = -(b * T + 2 * sigma * Math.sqrt(T)) * (b0 / (bInf - b0));
  const I = b0 + (bInf - b0) * (1 - Math.exp(ht));
  if (S >= I) return S - K;
  const alpha = (I - K) * I ** -beta;
  return (
    alpha * S ** beta -
    alpha *
      phi({
        spot: S,
        timeToExpiryYears: T,
        gamma: beta,
        trigger: I,
        boundary: I,
        riskFreeRate: r,
        carryRate: b,
        volatility: sigma,
      }) +
    phi({
      spot: S,
      timeToExpiryYears: T,
      gamma: 1,
      trigger: I,
      boundary: I,
      riskFreeRate: r,
      carryRate: b,
      volatility: sigma,
    }) -
    phi({
      spot: S,
      timeToExpiryYears: T,
      gamma: 1,
      trigger: K,
      boundary: I,
      riskFreeRate: r,
      carryRate: b,
      volatility: sigma,
    }) -
    K *
      phi({
        spot: S,
        timeToExpiryYears: T,
        gamma: 0,
        trigger: I,
        boundary: I,
        riskFreeRate: r,
        carryRate: b,
        volatility: sigma,
      }) +
    K *
      phi({
        spot: S,
        timeToExpiryYears: T,
        gamma: 0,
        trigger: K,
        boundary: I,
        riskFreeRate: r,
        carryRate: b,
        volatility: sigma,
      })
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

/** Bjerksund–Stensland (1993) American option price. */
export function bjerksundStenslandPrice(input: AmericanApproximationInput): number {
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
  const approximation =
    type === 'call'
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
  return americanFloor(input, approximation);
}

// ---- Bjerksund–Stensland (2002) ----

/**
 * The Ψ ("ksi") term of the 2002 model — a two-period extension of {@link phi} that spans `[0, t1]`
 * and `[0, T]` with boundary `I1` over the first leg and `I2` over the second, evaluated with the
 * cumulative bivariate normal at correlation `√(t1/T)`.
 */
function ksi(input: KsiInput): number {
  const {
    spot: S,
    timeToExpiryYears: T2,
    gamma,
    trigger: H,
    secondBoundary: I2,
    firstBoundary: I1,
    firstPeriod: t1,
    riskFreeRate: r,
    carryRate: b,
    volatility: sigma,
  } = input;
  const sig2 = sigma * sigma;
  const sqrt1 = Math.sqrt(t1);
  const sqrt2 = Math.sqrt(T2);
  const drift = b + (gamma - 0.5) * sig2;

  const e1 = (Math.log(S / I1) + drift * t1) / (sigma * sqrt1);
  const e2 = (Math.log((I2 * I2) / (S * I1)) + drift * t1) / (sigma * sqrt1);
  const e3 = (Math.log(S / I1) - drift * t1) / (sigma * sqrt1);
  const e4 = (Math.log((I2 * I2) / (S * I1)) - drift * t1) / (sigma * sqrt1);

  const f1 = (Math.log(S / H) + drift * T2) / (sigma * sqrt2);
  const f2 = (Math.log((I2 * I2) / (S * H)) + drift * T2) / (sigma * sqrt2);
  const f3 = (Math.log((I1 * I1) / (S * H)) + drift * T2) / (sigma * sqrt2);
  const f4 = (Math.log((S * I1 * I1) / (H * I2 * I2)) + drift * T2) / (sigma * sqrt2);

  const rho = Math.sqrt(t1 / T2);
  const lambda = -r + gamma * b + 0.5 * gamma * (gamma - 1) * sig2;
  const kappa = (2 * b) / sig2 + (2 * gamma - 1);

  return (
    Math.exp(lambda * T2) *
    S ** gamma *
    (bivariateNormalCdf(-e1, -f1, rho) -
      (I2 / S) ** kappa * bivariateNormalCdf(-e2, -f2, rho) -
      (I1 / S) ** kappa * bivariateNormalCdf(-e3, -f3, -rho) +
      (I1 / I2) ** kappa * bivariateNormalCdf(-e4, -f4, -rho))
  );
}

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
  const sig2 = sigma * sigma;
  const t1 = 0.5 * (Math.sqrt(5) - 1) * T;
  const beta = 0.5 - b / sig2 + Math.sqrt((b / sig2 - 0.5) ** 2 + (2 * r) / sig2);
  const bInf = (beta / (beta - 1)) * K;
  const b0 = Math.max(K, (r / (r - b)) * K);
  const denom = (bInf - b0) * b0;
  const ht1 = (-(b * t1 + 2 * sigma * Math.sqrt(t1)) * (K * K)) / denom;
  const ht2 = (-(b * T + 2 * sigma * Math.sqrt(T)) * (K * K)) / denom;
  const I1 = b0 + (bInf - b0) * (1 - Math.exp(ht1));
  const I2 = b0 + (bInf - b0) * (1 - Math.exp(ht2));
  if (S >= I2) return S - K;
  const alpha1 = (I1 - K) * I1 ** -beta;
  const alpha2 = (I2 - K) * I2 ** -beta;
  const phiBase = {
    spot: S,
    timeToExpiryYears: t1,
    riskFreeRate: r,
    carryRate: b,
    volatility: sigma,
  };
  const ksiBase = {
    spot: S,
    timeToExpiryYears: T,
    secondBoundary: I2,
    firstBoundary: I1,
    firstPeriod: t1,
    riskFreeRate: r,
    carryRate: b,
    volatility: sigma,
  };

  return (
    alpha2 * S ** beta -
    alpha2 * phi({ ...phiBase, gamma: beta, trigger: I2, boundary: I2 }) +
    phi({ ...phiBase, gamma: 1, trigger: I2, boundary: I2 }) -
    phi({ ...phiBase, gamma: 1, trigger: I1, boundary: I2 }) -
    K * phi({ ...phiBase, gamma: 0, trigger: I2, boundary: I2 }) +
    K * phi({ ...phiBase, gamma: 0, trigger: I1, boundary: I2 }) +
    alpha1 * phi({ ...phiBase, gamma: beta, trigger: I1, boundary: I2 }) -
    alpha1 * ksi({ ...ksiBase, gamma: beta, trigger: I1 }) +
    ksi({ ...ksiBase, gamma: 1, trigger: I1 }) -
    ksi({ ...ksiBase, gamma: 1, trigger: K }) -
    K * ksi({ ...ksiBase, gamma: 0, trigger: I1 }) +
    K * ksi({ ...ksiBase, gamma: 0, trigger: K })
  );
}

/** Bjerksund–Stensland (2002) American option price — the two-boundary refinement of the 1993 form. */
export function bjerksundStensland2002Price(input: AmericanApproximationInput): number {
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
  const approximation =
    type === 'call'
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
  return americanFloor(input, approximation);
}
