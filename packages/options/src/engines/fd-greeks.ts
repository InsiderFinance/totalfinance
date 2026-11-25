/**
 * Finite-difference **extended** Greeks for the numerical engines (spec: `docs/specs/full-greek-set.md`).
 *
 * The lattice / PDE / approximation engines have no closed-form higher-order Greeks (there is no analytic
 * form through an early-exercise boundary), so the full set is taken by central finite differences of the
 * engine's own price. The caller supplies two closures that already encode the model and the
 * discrete-dividend escrow:
 *   - `price({ spot, volatility, timeToExpiryYears, riskFreeRate, dividendYield })` — the engine's price at a bumped
 *     state,
 *   - `spotAt({ riskFreeRate, timeToExpiryYears })` — the escrowed spot at a bumped rate/time (a no-op with no
 *     discrete dividends).
 *
 * Every bump that moves the rate or the time-to-expiry re-escrows the spot (matching the first-order
 * `theta`/`rho` in `engine-factory.ts`), so the discrete-dividend PV moves with the bump rather than being
 * held fixed. Units match {@link blackScholesExtendedGreeks}: delta/gamma raw, vega/1%, theta/day, rho/1%, `phi` per
 * 1% dividend yield, the higher-order Greeks raw, `lambda` dimensionless. Verified to reproduce
 * `blackScholesExtendedGreeks` (via a BSM price closure) to ~1e-5 for the second-order and ~5e-5 for the third-order
 * Greeks.
 */

import type { ExtendedGreeks } from '../types.js';

/** The base state at which the Greeks are evaluated. `spot` is the already-escrowed spot at `(r, T)`. */
export interface FdGreekState {
  /** Escrowed spot at the base `(r, T)`. */
  spot: number;
  /** Time to expiry (years). */
  T: number;
  /** Risk-free rate. */
  r: number;
  /** Continuous dividend yield. */
  q: number;
  /** Volatility. */
  sigma: number;
}

/** Bump sizes; sensible defaults are derived from the state when omitted. */
export interface FdGreekSteps {
  spotStep?: number;
  volatilityStep?: number;
  timeStepYears?: number;
  rateStep?: number;
  dividendYieldStep?: number;
}

/** One fully named scalar state passed to a numerical pricing callback. */
export interface FdPriceInput {
  spot: number;
  volatility: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
}

/** Coordinates needed to recompute an escrowed spot after a rate or time bump. */
export interface FdSpotInput {
  riskFreeRate: number;
  timeToExpiryYears: number;
}

/** Cohesive request for the shared finite-difference Greek calculation. */
export interface FiniteDifferenceExtendedGreeksInput {
  price: (input: FdPriceInput) => number;
  spotAt: (input: FdSpotInput) => number;
  state: FdGreekState;
  steps?: FdGreekSteps;
}

/**
 * Each default bump is this fraction of its coordinate's natural scale (see {@link resolveFdSteps}).
 *
 * A central difference with step h has truncation error h²/6·f‴ (first derivative) and h²/12·f⁗
 * (second). Measured on the coordinate's own scale L, those are about (h/L)²/6 and (h/L)²/12 of the
 * Greek, so h = L/100 keeps truncation near 1e-5. Rounding contributes about ε/h (first derivative) and
 * 4ε/h² (second), with ε ≈ 1e-15·(S + K) for the closed forms. At h = L/100 that stays below 1e-6 of
 * an at-the-money gamma until the horizon volatility σ√T falls under about 1e-5.
 */
export const FD_RELATIVE_RESOLUTION = 1e-2;

/**
 * Smallest relative spot step. Below about √ε of the spot, a spot difference quotient keeps no
 * significant digits. Reached only at σ√T < 1e-6, where the price is essentially deterministic.
 */
const MIN_RELATIVE_SPOT_STEP = 1e-8;

/** Ceilings a caller may tighten for its own differencing order. */
export interface FdStepLimits {
  /**
   * Largest default time bump, in years. The default is 1e-3; first-order theta uses 1e-4. The
   * scale-aware bump `T/100` applies below whichever ceiling is set.
   */
  maximumTimeStepYears?: number;
}

/**
 * Resolve the ACTUAL scale-aware bump sizes for a state. Use this for a price that is a SMOOTH closed
 * form in every bumped coordinate (the American approximations, the digital closed form). Discretized,
 * sampled and shift-mode owners use {@link referenceFdSteps} instead. Callers disclose the returned
 * object in `diagnostics.finiteDifferenceBumps`.
 *
 * Every default is the previous fixed reference bump, capped at {@link FD_RELATIVE_RESOLUTION} of the
 * coordinate's natural scale. Ordinary contracts therefore keep the reference bumps exactly. A
 * narrow distribution (short expiry, low volatility) gets a bump that resolves it. The fixed
 * relative spot bump `S·1e-3` was wider than a one-day, 1%-vol distribution (σ√T·S ≈ 0.05 at S = 100),
 * so delta and gamma there came out 6% and 21% low. Scales and bumps, named as the diagnostics report
 * them:
 *
 *   - `spotStep`: spot scale `S·σ√T`, the terminal standard deviation. The bump is
 *     `S·min(1e-3, max(1e-8, σ√T/100))`.
 *   - `volatilityStep`: scale σ. The bump is `min(1e-3, σ/100)`, so `σ − h` stays positive at every
 *     level. Shift-mode callers whose `sigma` is a scalar shift around 0 (Heston √v₀, SABR α) pass
 *     `sigma: 0` and an explicit `volatilityStep` scaled to THEIR level.
 *   - `timeStepYears`: scale T. The bump is `min(ceiling, T/100)`, so `T − h` stays positive.
 *   - `rateStep` and `dividendYieldStep`: the drift moves the distribution by one standard deviation
 *     when the rate changes by `σ/√T`. The bumps are `min(1e-4, (σ/√T)/100)` and
 *     `min(1e-5, (σ/√T)/100)`.
 *
 * With `sigma ≤ 0` (shift mode), the spot, rate and carry bumps keep their fixed references, because
 * no distribution width is known. Explicit `steps` always win, and engines may raise the rate bump to
 * their own grid resolution (`rateStepFloor`).
 */
export function resolveFdSteps(
  state: FdGreekState,
  steps: FdGreekSteps = {},
  limits: FdStepLimits = {},
): Required<FdGreekSteps> {
  const { spot: s0, T, sigma } = state;
  const resolution = FD_RELATIVE_RESOLUTION;
  const widthKnown = sigma > 0;
  const horizonVolatility = sigma * Math.sqrt(T);
  const rateScale = sigma / Math.sqrt(T);
  return {
    spotStep:
      steps.spotStep ??
      s0 *
        (widthKnown
          ? Math.min(1e-3, Math.max(MIN_RELATIVE_SPOT_STEP, resolution * horizonVolatility))
          : 1e-3),
    volatilityStep:
      steps.volatilityStep ?? (widthKnown ? Math.min(1e-3, resolution * sigma) : 1e-3),
    timeStepYears:
      steps.timeStepYears ?? Math.min(limits.maximumTimeStepYears ?? 1e-3, resolution * T),
    rateStep: steps.rateStep ?? (widthKnown ? Math.min(1e-4, resolution * rateScale) : 1e-4),
    dividendYieldStep:
      steps.dividendYieldStep ?? (widthKnown ? Math.min(1e-5, resolution * rateScale) : 1e-5),
  };
}

/**
 * The previous fixed bump policy: spot `S·1e-3`, volatility `min(1e-3, σ/4)`, time
 * `min(ceiling, T/4)`, rate 1e-4 and carry 1e-5. Lattice and PDE engines keep it because their values
 * have node-level kinks that a finer spot bump would difference: S·σ√T/100 is about √N/100 of a node.
 * Shift-mode owners (SABR, Heston) keep it with their own vol shift. Monte Carlo keeps it because its
 * differences are variance-limited (below).
 *
 * Monte-Carlo Greeks difference common-random-number estimates. There, a second difference across
 * the payoff kink has variance proportional to 1/h, so the truncation-optimal
 * {@link resolveFdSteps} bump is not optimal. Measured over 12 seeds × 20,000 paths, the scale-aware
 * bump doubled the gamma error at 30 days and 10% vol (2.2% → 4.7% RMS) while removing the bias at one
 * day and 1% vol (21% → 6.8%). The right bump depends on the path count, which is a separate
 * decision, so Monte Carlo keeps this policy exactly.
 */
export function referenceFdSteps(
  state: FdGreekState,
  limits: FdStepLimits = {},
): Required<FdGreekSteps> {
  const { spot: s0, T, sigma } = state;
  return {
    spotStep: s0 * 1e-3,
    volatilityStep: sigma > 0 ? Math.min(1e-3, sigma / 4) : 1e-3,
    timeStepYears: Math.min(limits.maximumTimeStepYears ?? 1e-3, T / 4),
    rateStep: 1e-4,
    dividendYieldStep: 1e-5,
  };
}

/** One evaluation of the price at a bumped state, flagged when it is exactly the exercise value. */
export interface BranchedValue {
  value: number;
  /** The price IS the immediate-exercise value at this state (an American contract exercised now). */
  exercised: boolean;
}

/** Cohesive request for {@link branchAwareDifference}. */
export interface BranchAwareDifferenceInput {
  /** The evaluation at the base point. */
  base: BranchedValue;
  /** The evaluation at `offset × step` from the base along the differenced coordinate (offset ±1…±3). */
  evaluate: (offset: number) => BranchedValue;
  step: number;
  /**
   * Difference one-sided where a central stencil would straddle the exercise switch (scale-aware
   * closed forms). `false` keeps the plain central stencils of the discretized engines.
   */
  oneSided: boolean;
}

/**
 * First and second derivative along one coordinate. With `oneSided`, they are taken on the price
 * branch that contains the base point. Without it, they are the plain central stencils: discretized
 * (reference-policy) engines keep those, because a one-sided stencil reaches two and three bumps from
 * the base, into a lattice's own node structure.
 *
 * An American value has two branches: continuation, and the exercise region, where it equals the
 * immediate-exercise value exactly. The price is not twice differentiable where they meet, and the
 * closed-form approximations are not always even once differentiable there. A central stencil that
 * straddles that switch returns a secant slope and a curvature of about `(slope jump)/h`: an
 * artifact that grows as the bump shrinks. So when exactly one neighbour of the base lies on the
 * other branch, the derivative is taken one-sided, on the base's side, with the second-order stencils
 * `(−3V₀ + 4V₁ − V₂)/(2h)` and `(2V₀ − 5V₁ + 4V₂ − V₃)/h²`. Those cost two extra evaluations, only in
 * that band. An exercised base therefore reports the exercise value's own derivatives (spot slope ±1,
 * zero curvature, zero sensitivity to volatility, time and rates), and a base still holding reports
 * its continuation branch. The branch is read from exact equality with the exercise value, which
 * every American engine returns verbatim once exercise is optimal. A base isolated between two
 * switches within one step falls back to the central stencil. An ordinary stencil (all three points
 * on one branch) is exactly the central difference.
 */
export function branchAwareDifference(input: BranchAwareDifferenceInput): {
  first: number;
  second: number;
} {
  const { base, evaluate, step: h } = input;
  const up = evaluate(1);
  const down = evaluate(-1);
  const central = {
    first: (up.value - down.value) / (2 * h),
    second: (up.value - 2 * base.value + down.value) / (h * h),
  };
  if (!input.oneSided) return central;
  const upSame = up.exercised === base.exercised;
  const downSame = down.exercised === base.exercised;
  if (upSame === downSame) return central;
  const side = upSame ? 1 : -1;
  const near = upSame ? up : down;
  const middle = evaluate(2 * side);
  const far = evaluate(3 * side);
  if (middle.exercised !== base.exercised || far.exercised !== base.exercised) return central;
  return {
    first: (side * (-3 * base.value + 4 * near.value - middle.value)) / (2 * h),
    second: (2 * base.value - 5 * near.value + 4 * middle.value - far.value) / (h * h),
  };
}

/**
 * Full extended Greek set by central finite differences of `price`, re-escrowing the spot via `spotAt`
 * on every rate/time bump. A step not given in `steps` defaults to its {@link resolveFdSteps} value;
 * owners that keep the reference bumps pass {@link referenceFdSteps}. Disclose the same steps in
 * diagnostics.
 */
export function finiteDifferenceExtendedGreeks(
  input: FiniteDifferenceExtendedGreeksInput,
): ExtendedGreeks {
  const { price, spotAt, state, steps = {} } = input;
  const { spot: s0, T, r, q, sigma } = state;
  const {
    spotStep,
    volatilityStep: hV,
    timeStepYears,
    rateStep,
    dividendYieldStep,
  } = resolveFdSteps(state, steps);
  const P = (priceInput: FdPriceInput): number => price(priceInput);
  const p0 = P({
    spot: s0,
    volatility: sigma,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
  });

  // ── first order ──
  const delta =
    (P({
      spot: s0 + spotStep,
      volatility: sigma,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
    }) -
      P({
        spot: s0 - spotStep,
        volatility: sigma,
        timeToExpiryYears: T,
        riskFreeRate: r,
        dividendYield: q,
      })) /
    (2 * spotStep);
  const gamma =
    (P({
      spot: s0 + spotStep,
      volatility: sigma,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
    }) -
      2 * p0 +
      P({
        spot: s0 - spotStep,
        volatility: sigma,
        timeToExpiryYears: T,
        riskFreeRate: r,
        dividendYield: q,
      })) /
    (spotStep * spotStep);
  const vegaRaw =
    (P({
      spot: s0,
      volatility: sigma + hV,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
    }) -
      P({
        spot: s0,
        volatility: sigma - hV,
        timeToExpiryYears: T,
        riskFreeRate: r,
        dividendYield: q,
      })) /
    (2 * hV);
  // theta is calendar decay (−∂V/∂T); re-escrow at the bumped T (matches engine-factory).
  const spotAtLaterTime = spotAt({ riskFreeRate: r, timeToExpiryYears: T + timeStepYears });
  const spotAtEarlierTime = spotAt({ riskFreeRate: r, timeToExpiryYears: T - timeStepYears });
  const thetaYear =
    -(
      P({
        spot: spotAtLaterTime,
        volatility: sigma,
        timeToExpiryYears: T + timeStepYears,
        riskFreeRate: r,
        dividendYield: q,
      }) -
      P({
        spot: spotAtEarlierTime,
        volatility: sigma,
        timeToExpiryYears: T - timeStepYears,
        riskFreeRate: r,
        dividendYield: q,
      })
    ) /
    (2 * timeStepYears);
  const spotAtHigherRate = spotAt({ riskFreeRate: r + rateStep, timeToExpiryYears: T });
  const spotAtLowerRate = spotAt({ riskFreeRate: r - rateStep, timeToExpiryYears: T });
  const rhoRaw =
    (P({
      spot: spotAtHigherRate,
      volatility: sigma,
      timeToExpiryYears: T,
      riskFreeRate: r + rateStep,
      dividendYield: q,
    }) -
      P({
        spot: spotAtLowerRate,
        volatility: sigma,
        timeToExpiryYears: T,
        riskFreeRate: r - rateStep,
        dividendYield: q,
      })) /
    (2 * rateStep);
  const phiRaw =
    (P({
      spot: s0,
      volatility: sigma,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q + dividendYieldStep,
    }) -
      P({
        spot: s0,
        volatility: sigma,
        timeToExpiryYears: T,
        riskFreeRate: r,
        dividendYield: q - dividendYieldStep,
      })) /
    (2 * dividendYieldStep);

  // ── second / third order ──
  const vanna =
    (P({
      spot: s0 + spotStep,
      volatility: sigma + hV,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
    }) -
      P({
        spot: s0 + spotStep,
        volatility: sigma - hV,
        timeToExpiryYears: T,
        riskFreeRate: r,
        dividendYield: q,
      }) -
      P({
        spot: s0 - spotStep,
        volatility: sigma + hV,
        timeToExpiryYears: T,
        riskFreeRate: r,
        dividendYield: q,
      }) +
      P({
        spot: s0 - spotStep,
        volatility: sigma - hV,
        timeToExpiryYears: T,
        riskFreeRate: r,
        dividendYield: q,
      })) /
    (4 * spotStep * hV);
  const vomma =
    (P({
      spot: s0,
      volatility: sigma + hV,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
    }) -
      2 * p0 +
      P({
        spot: s0,
        volatility: sigma - hV,
        timeToExpiryYears: T,
        riskFreeRate: r,
        dividendYield: q,
      })) /
    (hV * hV);
  const speed =
    (P({
      spot: s0 + 2 * spotStep,
      volatility: sigma,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
    }) -
      2 *
        P({
          spot: s0 + spotStep,
          volatility: sigma,
          timeToExpiryYears: T,
          riskFreeRate: r,
          dividendYield: q,
        }) +
      2 *
        P({
          spot: s0 - spotStep,
          volatility: sigma,
          timeToExpiryYears: T,
          riskFreeRate: r,
          dividendYield: q,
        }) -
      P({
        spot: s0 - 2 * spotStep,
        volatility: sigma,
        timeToExpiryYears: T,
        riskFreeRate: r,
        dividendYield: q,
      })) /
    (2 * spotStep ** 3);
  const deltaAt = (t: number): number => {
    const s = spotAt({ riskFreeRate: r, timeToExpiryYears: t });
    return (
      (P({
        spot: s + spotStep,
        volatility: sigma,
        timeToExpiryYears: t,
        riskFreeRate: r,
        dividendYield: q,
      }) -
        P({
          spot: s - spotStep,
          volatility: sigma,
          timeToExpiryYears: t,
          riskFreeRate: r,
          dividendYield: q,
        })) /
      (2 * spotStep)
    );
  };
  const charm = (deltaAt(T + timeStepYears) - deltaAt(T - timeStepYears)) / (2 * timeStepYears); // ∂Δ/∂T
  const gammaAt = (v: number, t: number): number => {
    const s = spotAt({ riskFreeRate: r, timeToExpiryYears: t });
    return (
      (P({
        spot: s + spotStep,
        volatility: v,
        timeToExpiryYears: t,
        riskFreeRate: r,
        dividendYield: q,
      }) -
        2 * P({ spot: s, volatility: v, timeToExpiryYears: t, riskFreeRate: r, dividendYield: q }) +
        P({
          spot: s - spotStep,
          volatility: v,
          timeToExpiryYears: t,
          riskFreeRate: r,
          dividendYield: q,
        })) /
      (spotStep * spotStep)
    );
  };
  const color =
    (gammaAt(sigma, T + timeStepYears) - gammaAt(sigma, T - timeStepYears)) / (2 * timeStepYears); // ∂Γ/∂T
  const zomma = (gammaAt(sigma + hV, T) - gammaAt(sigma - hV, T)) / (2 * hV); // ∂Γ/∂σ
  const vegaAt = (t: number): number => {
    const s = spotAt({ riskFreeRate: r, timeToExpiryYears: t });
    return (
      (P({
        spot: s,
        volatility: sigma + hV,
        timeToExpiryYears: t,
        riskFreeRate: r,
        dividendYield: q,
      }) -
        P({
          spot: s,
          volatility: sigma - hV,
          timeToExpiryYears: t,
          riskFreeRate: r,
          dividendYield: q,
        })) /
      (2 * hV)
    );
  };
  const veta = (vegaAt(T + timeStepYears) - vegaAt(T - timeStepYears)) / (2 * timeStepYears); // ∂vega/∂T
  const rhoAt = (v: number): number =>
    (P({
      spot: spotAtHigherRate,
      volatility: v,
      timeToExpiryYears: T,
      riskFreeRate: r + rateStep,
      dividendYield: q,
    }) -
      P({
        spot: spotAtLowerRate,
        volatility: v,
        timeToExpiryYears: T,
        riskFreeRate: r - rateStep,
        dividendYield: q,
      })) /
    (2 * rateStep);
  const vera = (rhoAt(sigma + hV) - rhoAt(sigma - hV)) / (2 * hV); // ∂rho/∂σ
  const vommaAt = (v: number): number =>
    (P({ spot: s0, volatility: v + hV, timeToExpiryYears: T, riskFreeRate: r, dividendYield: q }) -
      2 * P({ spot: s0, volatility: v, timeToExpiryYears: T, riskFreeRate: r, dividendYield: q }) +
      P({
        spot: s0,
        volatility: v - hV,
        timeToExpiryYears: T,
        riskFreeRate: r,
        dividendYield: q,
      })) /
    (hV * hV);
  const ultima = (vommaAt(sigma + hV) - vommaAt(sigma - hV)) / (2 * hV); // ∂vomma/∂σ
  const lambdaRaw = (delta * s0) / p0; // Δ·S/V
  const lambda = Number.isFinite(lambdaRaw) ? lambdaRaw : null; // null at V=0, never ±∞/NaN

  return {
    delta,
    gamma,
    theta: thetaYear / 365,
    vega: vegaRaw / 100,
    rho: rhoRaw / 100,
    vanna,
    charm,
    vomma,
    speed,
    color,
    phi: phiRaw / 100,
    zomma,
    veta,
    vera,
    ultima,
    lambda,
  };
}
