/**
 * Lattice option engines (spec §9.3): binomial (CRR, Jarrow–Rudd, Tian, Leisen–Reimer) and
 * trinomial, with European/American exercise. These are the convergence reference for the
 * closed-form American approximations.
 *
 * Discrete cash dividends are handled by the escrowed-dividend approximation (spot reduced by the
 * present value of dividends paid before expiry) — documented and adequate for the lattice; a full
 * ex-date tree adjustment is a later refinement.
 *
 * Two invariants make a lattice value trustworthy, and both are enforced here:
 *   1. the branch probabilities are genuine probabilities — `engine.probability_out_of_range` when
 *      the per-step drift outruns the diffusion and they leave [0, 1];
 *   2. the first-order spot Greeks are read off the tree's OWN early nodes ({@link binomialSolve},
 *      {@link trinomialSolve}) rather than by re-pricing at a bumped spot. A bump smaller than the
 *      node spacing differences the lattice's sawtooth instead of the value function — that is how a
 *      gamma of 0.377 (or exactly 0) gets produced for a true 0.0189.
 */

import { ErrorCode, InputError, type OptionStyle, type OptionType } from '@totalfinance/core';
import { vanillaIntrinsicUnchecked } from '../payoff-kernel.js';

export type BinomialVariant = 'crr' | 'jarrow-rudd' | 'tian' | 'leisen-reimer';

function intrinsic(type: OptionType, S: number, K: number): number {
  return vanillaIntrinsicUnchecked({ type, underlyingPrice: S, strike: K });
}

/**
 * Peizer–Pratt inversion of the normal CDF used by the Leisen–Reimer tree.
 *
 * The result is nudged inside the OPEN interval (0, 1): the closed form saturates to exactly 0 or 1
 * once `|z|` is large (a vanishing volatility, or a spot far from the strike), and the tree's
 * `d = (drift − p·u)/(1 − p)` is then 0/0 → NaN — a "price" that used to reach an implied-volatility
 * search as a successful number. At the clamp the tree collapses to `u = d = drift`, which is exactly
 * the deterministic σ→0 limit it is approaching.
 */
function peizerPratt(z: number, n: number): number {
  const a = z / (n + 1 / 3 + 0.1 / (n + 1));
  const b = a * a * (n + 1 / 6);
  const p = 0.5 + Math.sign(z) * 0.5 * Math.sqrt(1 - Math.exp(-b));
  return Math.min(1 - PEIZER_PRATT_EPSILON, Math.max(PEIZER_PRATT_EPSILON, p));
}

/** How far inside (0, 1) the Peizer–Pratt probability is held (see {@link peizerPratt}). */
const PEIZER_PRATT_EPSILON = 1e-12;

interface Lattice {
  u: number;
  d: number;
  p: number;
}

/** The branch probabilities of one lattice parameterization, named as the caller reads them. */
interface ProbabilityCheckInput {
  /** Diagnostic label of the pricer that built them (e.g. `binomialPrice(crr)`). */
  method: string;
  /** Every branch probability the scheme produced, by name (`p`, or `pu`/`pm`/`pd`). */
  probabilities: Record<string, number>;
  timeStepYears: number;
  steps: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
  /** The engine-specific escape hatch appended to the teaching message. */
  alternative: string;
}

/**
 * Reject a lattice whose risk-neutral branch probabilities left [0, 1].
 *
 * A "probability" outside [0, 1] is not a slightly-worse discretization — the rolled-back value is a
 * signed combination with no risk-neutral meaning, and it can either explode (−2.6e51 for a European
 * call) or look perfectly plausible (a 4.4×-low American put). Both are silent wrong numbers, so
 * this is a hard failure carrying the actionable fix, mirroring the equity lattice's guard.
 */
function requireProbabilitiesInRange(input: ProbabilityCheckInput): void {
  const {
    method,
    probabilities,
    timeStepYears,
    steps,
    riskFreeRate,
    dividendYield,
    volatility,
    alternative,
  } = input;
  for (const [name, value] of Object.entries(probabilities)) {
    if (value >= 0 && value <= 1) continue;
    throw new InputError(
      `${method}: risk-neutral branch probability ${name}=${value} is outside [0, 1] — the tree is ` +
        `unstable at timeStepYears=${timeStepYears} (the per-step drift |riskFreeRate − dividendYield|·timeStepYears ` +
        `outran the diffusion volatility·√timeStepYears, so the branch weights — and every value rolled back ` +
        `through them — carry no risk-neutral meaning). Increase steps (a smaller timeStepYears), shorten ` +
        `timeToExpiryYears, or reduce |riskFreeRate − dividendYield| so that ` +
        `|riskFreeRate − dividendYield|·√timeStepYears < volatility; ${alternative}`,
      {
        code: ErrorCode.EngineProbabilityOutOfRange,
        context: {
          engine: method,
          probability: name,
          value,
          timeStepYears,
          steps,
          riskFreeRate,
          dividendYield,
          volatility,
        },
      },
    );
  }
}

function latticeParams(input: TreePriceParameters & { variant: BinomialVariant }): Lattice {
  const {
    variant,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
    steps,
  } = input;
  const timeStepYears = T / steps;
  const drift = Math.exp((r - q) * timeStepYears);
  const lattice = ((): Lattice => {
    switch (variant) {
      case 'crr': {
        const u = Math.exp(sigma * Math.sqrt(timeStepYears));
        const d = 1 / u;
        return { u, d, p: (drift - d) / (u - d) };
      }
      case 'jarrow-rudd': {
        const nu = r - q - 0.5 * sigma * sigma;
        const u = Math.exp(nu * timeStepYears + sigma * Math.sqrt(timeStepYears));
        const d = Math.exp(nu * timeStepYears - sigma * Math.sqrt(timeStepYears));
        return { u, d, p: (drift - d) / (u - d) };
      }
      case 'tian': {
        const v = Math.exp(sigma * sigma * timeStepYears);
        const root = Math.sqrt(v * v + 2 * v - 3);
        const u = 0.5 * drift * v * (v + 1 + root);
        const d = 0.5 * drift * v * (v + 1 - root);
        return { u, d, p: (drift - d) / (u - d) };
      }
      case 'leisen-reimer': {
        const sqrtT = Math.sqrt(T);
        const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
        const d2 = d1 - sigma * sqrtT;
        const p = peizerPratt(d2, steps);
        const pPrime = peizerPratt(d1, steps);
        const u = drift * (pPrime / p);
        const d = (drift - p * u) / (1 - p);
        return { u, d, p };
      }
    }
  })();
  // Leisen–Reimer's Peizer–Pratt inversion returns 0.5 ± 0.5·√(1 − e^{−b}) with b ≥ 0, so its `p` is
  // structurally inside (0, 1) for every finite parameter set — it is the escape hatch the message
  // below recommends, and a regression test pins that it never trips this guard.
  requireProbabilitiesInRange({
    method: `binomialPrice(${variant})`,
    probabilities: { p: lattice.p },
    timeStepYears,
    steps,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
    alternative:
      variant === 'leisen-reimer'
        ? 'the Leisen–Reimer probability is structurally in (0, 1), so a violation here means a non-finite input reached the tree.'
        : "or switch to engines.binomial({ variant: 'leisen-reimer' }), whose Peizer–Pratt probability is in (0, 1) by construction.",
  });
  return lattice;
}

export interface TreePriceParameters {
  type: OptionType;
  style: OptionStyle;
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
  steps: number;
}

/**
 * Three adjacent nodes of an early tree layer (ascending in spot) plus the layer's calendar time —
 * everything {@link latticeSpotGreeks} needs to read delta/gamma/theta off the tree itself.
 */
export interface EarlyTreeLayer {
  /** Node spots, strictly ascending. */
  spots: [number, number, number];
  /** Node values, aligned with `spots`. */
  values: [number, number, number];
  /** Calendar time of the layer, in years from valuation (`stepIndex · timeStepYears`). */
  timeYears: number;
}

/** A rolled-back lattice: the root value plus the early layer used for native spot Greeks. */
export interface TreeSolution {
  value: number;
  /** Absent when the tree is too shallow to expose an interior layer (binomial steps < 3, trinomial < 2). */
  early: EarlyTreeLayer | undefined;
}

/** First-order Greeks read directly off a discretization, in raw (unscaled) units. */
export interface NativeSpotGreeks {
  delta: number;
  gamma: number;
  /** ∂V/∂t per YEAR (calendar decay, so negative for a long option). */
  thetaPerYear: number;
}

/**
 * Delta, gamma and theta from three adjacent nodes of an early layer.
 *
 * The three-point formulas are the exact derivatives of the parabola through the (unequally spaced)
 * nodes, evaluated at the middle node and then Taylor-shifted to the valuation spot — the shift is
 * what keeps Jarrow–Rudd/Tian/Leisen–Reimer honest, since only CRR has a middle node sitting exactly
 * on `spot`. Theta compares the layer's value AT the spot with the root value over the layer's own
 * elapsed time, so no re-pricing at a bumped maturity is involved.
 */
export function latticeSpotGreeks(input: {
  spot: number;
  rootValue: number;
  early: EarlyTreeLayer;
}): NativeSpotGreeks {
  const { spot: S, rootValue, early } = input;
  const [x0, x1, x2] = early.spots;
  const [v0, v1, v2] = early.values;
  const h1 = x1 - x0;
  const h2 = x2 - x1;
  const firstDerivative =
    (-h2 / (h1 * (h1 + h2))) * v0 + ((h2 - h1) / (h1 * h2)) * v1 + (h1 / (h2 * (h1 + h2))) * v2;
  const secondDerivative = 2 * (v0 / (h1 * (h1 + h2)) - v1 / (h1 * h2) + v2 / (h2 * (h1 + h2)));
  const offset = S - x1;
  const delta = firstDerivative + secondDerivative * offset;
  const gamma = secondDerivative;
  // The layer's value AT the valuation spot (second-order Taylor from the middle node).
  const valueAtSpot = v1 + firstDerivative * offset + 0.5 * secondDerivative * offset * offset;
  const thetaPerYear = (valueAtSpot - rootValue) / early.timeYears;
  return { delta, gamma, thetaPerYear };
}

/** Roll a binomial tree back to the root, capturing the step-2 layer for native Greeks. */
export function binomialSolve(variant: BinomialVariant, p: TreePriceParameters): TreeSolution {
  const steps = Math.max(1, Math.floor(p.steps));
  const timeStepYears = p.timeToExpiryYears / steps;
  const disc = Math.exp(-p.riskFreeRate * timeStepYears);
  const { u, d, p: prob } = latticeParams({ ...p, variant, steps });

  const values = new Array<number>(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const ST = p.spot * u ** (steps - i) * d ** i;
    values[i] = intrinsic(p.type, ST, p.strike);
  }
  let early: EarlyTreeLayer | undefined;
  for (let step = steps - 1; step >= 0; step--) {
    for (let i = 0; i <= step; i++) {
      let cont = disc * (prob * values[i]! + (1 - prob) * values[i + 1]!);
      if (p.style === 'american') {
        const ST = p.spot * u ** (step - i) * d ** i;
        cont = Math.max(cont, intrinsic(p.type, ST, p.strike));
      }
      values[i] = cont;
    }
    // The step-2 layer (three nodes at 2·timeStepYears) is the standard source of a binomial tree's
    // own delta/gamma/theta. A 1- or 2-step tree never reaches it, and the caller falls back to bumps.
    if (step === 2) {
      early = {
        spots: [p.spot * d * d, p.spot * u * d, p.spot * u * u],
        values: [values[2]!, values[1]!, values[0]!],
        timeYears: 2 * timeStepYears,
      };
    }
  }
  return { value: values[0]!, early };
}

/** Binomial tree price (American or European). */
export function binomialPrice(variant: BinomialVariant, p: TreePriceParameters): number {
  return binomialSolve(variant, p).value;
}

/** Roll a trinomial tree back to the root, capturing the step-1 layer for native Greeks. */
export function trinomialSolve(p: TreePriceParameters): TreeSolution {
  const steps = Math.max(1, Math.floor(p.steps));
  const timeStepYears = p.timeToExpiryYears / steps;
  const disc = Math.exp(-p.riskFreeRate * timeStepYears);
  const u = Math.exp(p.volatility * Math.sqrt(2 * timeStepYears)); // down move is u^{-1}; node spots use u^j directly

  const eHalf = Math.exp(((p.riskFreeRate - p.dividendYield) * timeStepYears) / 2);
  const eSig = Math.exp(p.volatility * Math.sqrt(timeStepYears / 2));
  const eSigInv = 1 / eSig;
  const pu = ((eHalf - eSigInv) / (eSig - eSigInv)) ** 2;
  const pd = ((eSig - eHalf) / (eSig - eSigInv)) ** 2;
  const pm = 1 - pu - pd;
  // Boyle's parameterization squares its numerators, so pu/pd stay non-negative while pm goes
  // silently negative (pu = 1.31, pm = −0.33 at σ=1%, r=10%, T=10): all three are checked.
  requireProbabilitiesInRange({
    method: 'trinomialPrice',
    probabilities: { pu, pm, pd },
    timeStepYears,
    steps,
    riskFreeRate: p.riskFreeRate,
    dividendYield: p.dividendYield,
    volatility: p.volatility,
    alternative:
      "or switch to engines.binomial({ variant: 'leisen-reimer' }), whose Peizer–Pratt probability is in (0, 1) by construction.",
  });

  const size = 2 * steps + 1;
  const values = new Array<number>(size);
  for (let i = 0; i < size; i++) {
    const j = steps - i; // node exponent from +steps down to -steps
    const ST = p.spot * u ** j;
    values[i] = intrinsic(p.type, ST, p.strike);
  }
  let early: EarlyTreeLayer | undefined;
  for (let step = steps - 1; step >= 0; step--) {
    const width = 2 * step + 1;
    for (let i = 0; i < width; i++) {
      let cont = disc * (pu * values[i]! + pm * values[i + 1]! + pd * values[i + 2]!);
      if (p.style === 'american') {
        const j = step - i;
        const ST = p.spot * u ** j;
        cont = Math.max(cont, intrinsic(p.type, ST, p.strike));
      }
      values[i] = cont;
    }
    // A trinomial's step-1 layer already straddles the spot (its middle node IS S·u⁰), so the native
    // Greeks come from one time step rather than two.
    if (step === 1) {
      early = {
        spots: [p.spot / u, p.spot, p.spot * u],
        values: [values[2]!, values[1]!, values[0]!],
        timeYears: timeStepYears,
      };
    }
  }
  return { value: values[0]!, early };
}

/** Trinomial tree price (American or European). */
export function trinomialPrice(p: TreePriceParameters): number {
  return trinomialSolve(p).value;
}
