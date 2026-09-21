/**
 * Crank–Nicolson finite-difference engine (spec §9.3).
 *
 * Solves the Black–Scholes PDE on a uniform price grid with the Crank–Nicolson (θ = ½) scheme. The
 * American early-exercise constraint is imposed as a linear complementarity problem solved by
 * Projected SOR (PSOR) at each time step. The price at the requested spot is linearly interpolated
 * off the grid.
 *
 * The grid is sized from the DISTRIBUTION, not from a fixed multiple of the spot:
 *
 *   • `Smax = max(4·max(S, K), S·e^{(r−q)T + 4σ√T})` — a σ√T-blind truncation at 4·max(S, K) chops
 *     real probability mass off a long-dated/high-vol contract (+45% at T=10, σ=1.5) and says nothing;
 *   • the grid is refined until at least {@link NEAR_STRIKE_NODES} nodes span `K ± 2σ√T·S`, so the
 *     payoff kink stays resolved as `Smax` grows (a σ√T-aware domain on a coarse grid just trades
 *     one bias for another; the short-dated −5.5% case is exactly that);
 *   • that refinement is capped at {@link GRID_POINT_CAP} nodes. When the cap binds, the domain is
 *     truncated to what the budget can resolve and the result is flagged
 *     `engine.discretization_inadequate` with `converged: false` — a uniform-in-S grid genuinely
 *     cannot both span 4σ√T of a σ√T ≈ 4.7 distribution and resolve the strike, and saying so is the
 *     only honest option.
 *
 * The upper boundary carries the carry: a call at `Smax` is worth `Smax·e^{−qτ} − K·e^{−rτ}`, and an
 * American one at least its intrinsic `Smax − K`; the omitted `e^{−qτ}` was a dividend-blind bias of
 * its own at long maturities.
 */

import {
  ConvergenceError,
  ErrorCode,
  type OptionStyle,
  type OptionType,
  type QuantWarning,
  warning,
} from '@totalfinance/core';
import { linearInterp } from '@totalfinance/math';
import { vanillaIntrinsicUnchecked } from '../payoff-kernel.js';

export interface FdmParameters {
  type: OptionType;
  style: OptionStyle;
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
  gridPoints: number;
  timeSteps: number;
}

/** Minimum number of grid nodes across the `K ± 2σ√T·S` window where the payoff kink lives. */
export const NEAR_STRIKE_NODES = 25;
/** Ceiling on AUTOMATIC grid refinement (an explicit larger `gridPoints` request is still honored). */
export const GRID_POINT_CAP = 1600;

/** The grid a Crank–Nicolson solve actually ran on — disclosed, never assumed by the caller. */
export interface FdmGrid {
  /** Upper truncation of the price domain. */
  maximumSpot: number;
  /** Number of price intervals (the grid has `gridPoints + 1` nodes). */
  gridPoints: number;
  timeSteps: number;
  /** Uniform node spacing `maximumSpot / gridPoints`. */
  spotStep: number;
}

/** A completed Crank–Nicolson solve: the price, the grid's own Greeks, and its honest diagnostics. */
export interface FdmSolution {
  value: number;
  /** ∂V/∂S from the spatial stencil at the grid's OWN spacing (never a sub-grid bump). */
  delta: number;
  /** ∂²V/∂S² from the same stencil. */
  gamma: number;
  /** ∂V/∂t per YEAR, from the first two time levels of the solve. */
  thetaPerYear: number;
  /** `false` when the grid could not be refined enough for the requested regime. */
  converged: boolean;
  warnings: QuantWarning[];
  grid: FdmGrid;
}

/**
 * Thomas algorithm for the Crank–Nicolson step on interior nodes `1 … size−1`:
 *
 *   −a[j]·V[j−1] + (1 − b[j])·V[j] − c[j]·V[j+1] = rhs[j]
 *
 * with `out[0]` / `out[size]` already holding the Dirichlet boundary values. The interior solution is
 * written back into `out`. Exact (no iteration): a European price is never a function of a residual
 * tolerance.
 */
function solveTridiagonal(input: {
  lower: number[];
  diagonal: number[];
  upper: number[];
  rhs: number[];
  out: number[];
  size: number;
}): void {
  const { lower: a, diagonal: b, upper: c, rhs, out, size: M } = input;
  const n = M - 1; // interior count
  if (n < 1) return;
  const cPrime = new Array<number>(M).fill(0);
  const dPrime = new Array<number>(M).fill(0);
  const rhsAt = (j: number): number =>
    rhs[j]! + (j === 1 ? a[1]! * out[0]! : 0) + (j === M - 1 ? c[M - 1]! * out[M]! : 0);
  let denominator = 1 - b[1]!;
  cPrime[1] = -c[1]! / denominator;
  dPrime[1] = rhsAt(1) / denominator;
  for (let j = 2; j <= M - 1; j++) {
    denominator = 1 - b[j]! - -a[j]! * cPrime[j - 1]!;
    cPrime[j] = -c[j]! / denominator;
    dPrime[j] = (rhsAt(j) - -a[j]! * dPrime[j - 1]!) / denominator;
  }
  out[M - 1] = dPrime[M - 1]!;
  for (let j = M - 2; j >= 1; j--) out[j] = dPrime[j]! - cPrime[j]! * out[j + 1]!;
}

/** Resolve the price domain and node count for one contract (see the module docstring). */
function resolveGrid(p: FdmParameters): {
  grid: FdmGrid;
  adequate: boolean;
  requiredPoints: number;
  idealMaximumSpot: number;
} {
  const requested = Math.max(40, Math.floor(p.gridPoints));
  const timeSteps = Math.max(40, Math.floor(p.timeSteps));
  const anchor = Math.max(p.spot, p.strike);
  const volatilityRootTime = p.volatility * Math.sqrt(p.timeToExpiryYears);
  // Four standard deviations of log-spot beyond the forward, floored at the historical 4·max(S, K).
  const idealMaximumSpot = Math.max(
    4 * anchor,
    p.spot *
      Math.exp((p.riskFreeRate - p.dividendYield) * p.timeToExpiryYears + 4 * volatilityRootTime),
  );
  // Resolution the payoff kink needs: NEAR_STRIKE_NODES nodes across K ± 2σ√T·S.
  const nearStrikeStep = (4 * volatilityRootTime * p.spot) / NEAR_STRIKE_NODES;
  const requiredPoints = Math.ceil(idealMaximumSpot / nearStrikeStep);
  const gridPoints = Math.max(requested, Math.min(requiredPoints, GRID_POINT_CAP));
  const affordableMaximumSpot = gridPoints * nearStrikeStep;
  // Never truncate tighter than the historical 4·max(S, K) domain, whatever the resolution rule asks.
  const maximumSpot = Math.max(4 * anchor, Math.min(idealMaximumSpot, affordableMaximumSpot));
  const spotStep = maximumSpot / gridPoints;
  const adequate =
    maximumSpot >= idealMaximumSpot * (1 - 1e-12) && spotStep <= nearStrikeStep * (1 + 1e-12);
  return {
    grid: { maximumSpot, gridPoints, timeSteps, spotStep },
    adequate,
    requiredPoints,
    idealMaximumSpot,
  };
}

/**
 * Crank–Nicolson solve returning the price, the grid's native first-order Greeks, and diagnostics.
 *
 * `delta`/`gamma` come from the three-point stencil around the grid node nearest the spot, at the
 * grid's OWN spacing, Taylor-shifted to the spot; `theta` from the first two time levels. A
 * bump-and-reprice Greek at a sub-`dS` step differences the linear interpolation between two fixed
 * nodes — which is exactly zero curvature, or a sawtooth once the bump straddles a node.
 */
export function crankNicolsonSolve(p: FdmParameters): FdmSolution {
  const { grid, adequate, requiredPoints, idealMaximumSpot } = resolveGrid(p);
  const M = grid.gridPoints;
  const N = grid.timeSteps;
  const Smax = grid.maximumSpot;
  const dS = grid.spotStep;
  const timeStepYears = p.timeToExpiryYears / N;
  const r = p.riskFreeRate;
  const q = p.dividendYield;
  const sig2 = p.volatility * p.volatility;

  const payoff = (S: number): number =>
    vanillaIntrinsicUnchecked({ type: p.type, underlyingPrice: S, strike: p.strike });

  let V = new Array<number>(M + 1);
  for (let j = 0; j <= M; j++) V[j] = payoff(j * dS);

  const a = new Array<number>(M + 1).fill(0);
  const b = new Array<number>(M + 1).fill(0);
  const c = new Array<number>(M + 1).fill(0);
  for (let j = 1; j < M; j++) {
    a[j] = 0.25 * timeStepYears * (sig2 * j * j - (r - q) * j);
    b[j] = -0.5 * timeStepYears * (sig2 * j * j + r);
    c[j] = 0.25 * timeStepYears * (sig2 * j * j + (r - q) * j);
  }

  // Relaxation factor for the American LCP sweep. The classical fixed 1.4 converges at a rate that
  // degrades like 1 − O(1/M), so a refined grid (M in the hundreds, let alone the 1600-node cap)
  // cannot reach the residual floor inside any sane iteration budget; the optimal-SOR value for a
  // tridiagonal system, capped at 1.9 for the projection's stability, keeps the sweep count flat.
  const omega = Math.min(1.9, 2 / (1 + Math.sin(Math.PI / M)));
  // Residual floors scale with the value scale — an absolute 1e-9 is below double precision once the
  // grid (and therefore the call's upper boundary) reaches 1e5.
  const valueScale = Math.max(1, p.strike, p.spot, Smax * Math.exp(-q * p.timeToExpiryYears));
  const residualFloor = 1e-9 * valueScale;
  const residualFailure = 1e-6 * valueScale;
  // The level one time step after valuation (t = dt), kept for the native theta.
  let levelAfterValuation: number[] | undefined;
  for (let n = N - 1; n >= 0; n--) {
    if (n === 0) levelAfterValuation = V;
    const tau = p.timeToExpiryYears - n * timeStepYears;
    const discountedStrike = p.strike * Math.exp(-r * tau);
    // A call at Smax is (almost) certainly exercised, so it is worth the FORWARD of the truncation
    // level less the discounted strike — Smax·e^{−qτ} − K·e^{−rτ}, not Smax − K·e^{−rτ}.
    const europeanUpper =
      p.type === 'call' ? Math.max(0, Smax * Math.exp(-q * tau) - discountedStrike) : 0;
    // At S = 0 a call is worthless; a European put is worth the discounted strike, and an American
    // put its immediate exercise value K (exercising at S = 0 is optimal and always available).
    const europeanLower = p.type === 'call' ? 0 : discountedStrike;
    const lower =
      p.style === 'american' && p.type === 'put'
        ? Math.max(europeanLower, p.strike)
        : europeanLower;
    const upper =
      p.style === 'american' && p.type === 'call'
        ? Math.max(europeanUpper, Smax - p.strike)
        : europeanUpper;

    const rhs = new Array<number>(M + 1).fill(0);
    for (let j = 1; j < M; j++)
      rhs[j] = a[j]! * V[j - 1]! + (1 + b[j]!) * V[j]! + c[j]! * V[j + 1]!;

    const Vnew = V.slice();
    Vnew[0] = lower;
    Vnew[M] = upper;
    if (p.style === 'european') {
      // No obstacle ⇒ a plain tridiagonal system: the Thomas algorithm solves it EXACTLY in O(M),
      // so a European price never depends on an iteration budget at all.
      solveTridiagonal({ lower: a, diagonal: b, upper: c, rhs, out: Vnew, size: M });
    } else {
      const maximumIterations = 10000;
      let residual = Infinity;
      for (let iter = 0; iter < maximumIterations; iter++) {
        let err = 0;
        for (let j = 1; j < M; j++) {
          const gaussSeidel = (rhs[j]! + a[j]! * Vnew[j - 1]! + c[j]! * Vnew[j + 1]!) / (1 - b[j]!);
          let vj = Vnew[j]! + omega * (gaussSeidel - Vnew[j]!);
          vj = Math.max(vj, payoff(j * dS));
          const difference = vj - Vnew[j]!;
          err += difference * difference;
          Vnew[j] = vj;
        }
        residual = Math.sqrt(err);
        if (residual < residualFloor) break;
      }
      // Honest non-convergence (design law #4): never return a guessed grid as if it converged. A
      // residual still above a loose floor after `maximumIterations` PSOR sweeps means the solve genuinely failed.
      if (residual > residualFailure) {
        throw new ConvergenceError(
          `crankNicolson: PSOR did not converge at time step ${n} (residual ${residual.toExponential(2)} after ${maximumIterations} iterations).`,
          {
            code: ErrorCode.SolverNoConvergence,
            context: { step: n, residual, maximumIterations, gridPoints: M },
          },
        );
      }
    }
    V = Vnew;
  }

  const xs = Array.from({ length: M + 1 }, (_, j) => j * dS);
  const value = linearInterp(xs, V, p.spot);

  // ── native spot Greeks: the grid's own stencil, centred on the node nearest the spot ──
  const centre = Math.min(M - 1, Math.max(1, Math.round(p.spot / dS)));
  const centredDelta = (V[centre + 1]! - V[centre - 1]!) / (2 * dS);
  const gamma = (V[centre + 1]! - 2 * V[centre]! + V[centre - 1]!) / (dS * dS);
  const offset = p.spot - centre * dS;
  const delta = centredDelta + gamma * offset;
  const previousLevel = levelAfterValuation ?? V;
  const thetaPerYear = (linearInterp(xs, previousLevel, p.spot) - value) / timeStepYears;

  const warnings: QuantWarning[] = adequate
    ? []
    : [
        warning(
          ErrorCode.EngineDiscretizationInadequate,
          `crankNicolson: this regime needs ~${requiredPoints} grid points to span ` +
            `S·e^{(r−q)T + 4σ√T} = ${idealMaximumSpot.toExponential(2)} while keeping ${NEAR_STRIKE_NODES} nodes ` +
            `across K ± 2σ√T·S; the grid was capped at ${M} points over [0, ${Smax.toExponential(2)}], so the ` +
            `value is truncation-biased (low for a call) and is reported unconverged. Raise gridPoints, or price ` +
            `this regime with a lattice — engines.binomial({ variant: 'leisen-reimer', steps: 1001 }) — whose ` +
            `multiplicative grid spans σ√T natively.`,
          'warn',
          {
            requiredGridPoints: requiredPoints,
            gridPoints: M,
            maximumSpot: Smax,
            idealMaximumSpot,
            spotStep: dS,
            volatilityRootTime: p.volatility * Math.sqrt(p.timeToExpiryYears),
          },
        ),
      ];

  return { value, delta, gamma, thetaPerYear, converged: adequate, warnings, grid };
}

/** Crank–Nicolson price at the requested spot. */
export function crankNicolsonPrice(p: FdmParameters): number {
  return crankNicolsonSolve(p).value;
}
