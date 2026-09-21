/**
 * Shared terminal-price distribution quadrature (Wave 6 §2B) — the ONE probability-mass path the
 * strategy optimizer and the what-if cube both integrate against, so a probability is always a *mass
 * over an interval*, never an unscaled point density.
 *
 * `priceGridDistribution` turns an ordered price grid into non-overlapping midpoint bins and assigns
 * each bin a probability: a lognormal law uses exact CDF differences (in log space); a custom density
 * uses normalized trapezoidal quadrature over its explicit support. Mass outside the grid is disclosed
 * as `tailBelow` / `tailAbove`; the returned node probabilities are renormalized to sum to 1 over the
 * in-grid mass (a `report-and-renormalize` policy — the tails are never silently dropped). This module
 * is INTERNAL: it is imported directly by `optimizer.ts` and `what-if-cube.ts`, not from the package
 * root.
 */

import { normalCdf } from '@totalfinance/math';

/** A lognormal terminal-price law with the horizon already folded into `muLog` / `sigma`. */
export interface LognormalLaw {
  kind: 'lognormal';
  /** Mean of `ln S_T`. */
  muLog: number;
  /** Standard deviation of `ln S_T` (`vol · √t`), > 0. */
  sigma: number;
}

/** A custom terminal-price density over an explicit, finite support, evaluated at a fixed horizon. */
export interface CustomDensityLaw {
  kind: 'custom';
  density: (price: number, yearsForward: number) => number;
  from: number;
  to: number;
  yearsForward: number;
}

export type TerminalPriceLaw = LognormalLaw | CustomDensityLaw;

/** A resolved terminal-price bin: a representative price and its (renormalized in-grid) mass. */
export interface PriceMassNode {
  price: number;
  probability: number;
}

/** An ordered price grid resolved into probability mass, with the out-of-grid tails disclosed. */
export interface ResolvedPriceDistribution {
  /** One node per input price, `probability` renormalized to sum to 1 over the in-grid mass. */
  nodes: PriceMassNode[];
  /** Probability mass below the grid's lower edge (before renormalization). */
  tailBelow: number;
  /** Probability mass above the grid's upper edge (before renormalization). */
  tailAbove: number;
  /** In-grid mass before renormalization (`= 1 − tailBelow − tailAbove` for a proper law). */
  inGridMass: number;
}

/** Midpoint bin edges of an ordered grid: interior edges are neighbor midpoints, ends extrapolate. */
function midpointEdges(prices: readonly number[]): { lo: number[]; hi: number[] } {
  const n = prices.length;
  const lo = new Array<number>(n);
  const hi = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    lo[i] =
      i === 0 ? prices[0]! - (prices[1]! - prices[0]!) / 2 : (prices[i - 1]! + prices[i]!) / 2;
    hi[i] =
      i === n - 1
        ? prices[n - 1]! + (prices[n - 1]! - prices[n - 2]!) / 2
        : (prices[i]! + prices[i + 1]!) / 2;
  }
  return { lo, hi };
}

/** Trapezoidal integral of a non-negative density over `[a, b]` at a fixed horizon; 0 when `b ≤ a`. */
function integrateDensity(input: {
  density: (price: number, yearsForward: number) => number;
  yearsForward: number;
  a: number;
  b: number;
}): number {
  const { density, yearsForward, a, b } = input;
  if (!(b > a)) return 0;
  const STEPS = 256;
  const h = (b - a) / STEPS;
  let sum = 0;
  for (let i = 0; i <= STEPS; i++) {
    const d = density(a + i * h, yearsForward);
    if (Number.isFinite(d) && d >= 0) sum += (i === 0 || i === STEPS ? 0.5 : 1) * d;
  }
  return sum * h;
}

/**
 * The probability mass over the midpoint bins of `prices` under `law`, renormalized to sum to 1 with
 * the out-of-grid tails disclosed. `prices` must be strictly increasing with ≥ 2 entries.
 */
export function priceGridDistribution(input: {
  prices: readonly number[];
  law: TerminalPriceLaw;
}): ResolvedPriceDistribution {
  const { prices, law } = input;
  const n = prices.length;
  const { lo, hi } = midpointEdges(prices);
  const rawMass = new Array<number>(n);
  let tailBelow = 0;
  let tailAbove = 0;

  if (law.kind === 'lognormal') {
    const zln = (price: number): number =>
      (Math.log(Math.max(Number.MIN_VALUE, price)) - law.muLog) / law.sigma;
    for (let i = 0; i < n; i++) rawMass[i] = normalCdf(zln(hi[i]!)) - normalCdf(zln(lo[i]!));
    tailBelow = normalCdf(zln(lo[0]!));
    tailAbove = 1 - normalCdf(zln(hi[n - 1]!));
  } else {
    // Custom density: midpoint-bin quadrature (density × bin width) — correct for a NON-uniform grid,
    // and the same midpoint-bin convention as the lognormal branch. Mass in the explicit support but
    // OUTSIDE the grid is integrated as the disclosed tails (≈ 0 when the grid already spans the
    // support, e.g. the optimizer's `customPriceGrid`; > 0 when the grid is narrower, e.g. the cube).
    for (let i = 0; i < n; i++) {
      const d = law.density(prices[i]!, law.yearsForward);
      const width = hi[i]! - lo[i]!;
      rawMass[i] = Number.isFinite(d) && d >= 0 && width > 0 ? d * width : 0;
    }
    tailBelow = integrateDensity({
      density: law.density,
      yearsForward: law.yearsForward,
      a: law.from,
      b: lo[0]!,
    });
    tailAbove = integrateDensity({
      density: law.density,
      yearsForward: law.yearsForward,
      a: hi[n - 1]!,
      b: law.to,
    });
  }

  let inGridMass = 0;
  for (let i = 0; i < n; i++) inGridMass += rawMass[i]!;
  const norm = inGridMass > 0 ? inGridMass : 1;
  const nodes: PriceMassNode[] = prices.map((price, i) => ({
    price,
    probability: rawMass[i]! / norm,
  }));
  return { nodes, tailBelow, tailAbove, inGridMass };
}

/** Build a log-uniform price grid spanning `±windowSigmas` of a lognormal law (geometric spacing). */
export function lognormalPriceGrid(
  law: LognormalLaw,
  gridPoints: number,
  windowSigmas = 6,
): number[] {
  const lo = law.muLog - windowSigmas * law.sigma;
  const du = (2 * windowSigmas * law.sigma) / (gridPoints - 1);
  return Array.from({ length: gridPoints }, (_, i) => Math.exp(lo + i * du));
}

/** Build a linearly spaced price grid over a custom density's explicit `[from, to]` support. */
export function customPriceGrid(range: { from: number; to: number; gridPoints: number }): number[] {
  const { from, to, gridPoints } = range;
  const dS = (to - from) / (gridPoints - 1);
  return Array.from({ length: gridPoints }, (_, i) => from + i * dS);
}

/** One terminal-price outcome scored against a position's expiration P&L. */
export interface ThesisOutcomeNode {
  terminalPrice: number;
  probability: number;
  pnl: number;
}

/**
 * Score a resolved price distribution against an expiration-P&L function: the probability-weighted EV
 * and the probability of a positive P&L, plus the per-node outcomes. This is the single source the
 * optimizer's thesis EV / PoP flow through.
 */
export function scoreOutcomes(
  distribution: ResolvedPriceDistribution,
  pnlAt: (price: number) => number,
): { nodes: ThesisOutcomeNode[]; ev: number; pop: number } {
  let ev = 0;
  let pop = 0;
  const nodes: ThesisOutcomeNode[] = distribution.nodes.map((nd) => {
    const pnl = pnlAt(nd.price);
    ev += nd.probability * pnl;
    if (pnl > 0) pop += nd.probability;
    return { terminalPrice: nd.price, probability: nd.probability, pnl };
  });
  return { nodes, ev, pop };
}
