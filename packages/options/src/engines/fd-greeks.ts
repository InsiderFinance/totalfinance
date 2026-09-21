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
 * Resolve the ACTUAL bump sizes for a state — adaptive near boundaries (spec P2.3), one source of
 * truth shared by the FD helpers and the engine adapters that disclose the bumps in diagnostics:
 *
 * Named as the caller reads them back out of `diagnostics.finiteDifferenceBumps`:
 *
 *   - `spotStep` is relative to the (escrowed) spot;
 *   - `volatilityStep` shrinks to `σ/4` when the vol LEVEL sits below 4·10⁻³, so `σ − h` never
 *     crosses zero (a negative vol handed to a pricer is NaN territory). Shift-mode callers whose
 *     `sigma` is a scalar shift around 0 (Heston √v₀, SABR α) pass an explicit `volatilityStep`
 *     scaled to THEIR level;
 *   - `timeStepYears` shrinks to `T/4` near expiry so `T − h` stays strictly positive;
 *   - `rateStep`/`dividendYieldStep` stay fixed — rates and carry are signed quantities with no
 *     boundary to cross.
 */
export function resolveFdSteps(
  state: FdGreekState,
  steps: FdGreekSteps = {},
): Required<FdGreekSteps> {
  const { spot: s0, T, sigma } = state;
  return {
    spotStep: steps.spotStep ?? s0 * 1e-3,
    volatilityStep: steps.volatilityStep ?? (sigma > 0 ? Math.min(1e-3, sigma / 4) : 1e-3),
    timeStepYears: steps.timeStepYears ?? Math.min(1e-3, T / 4),
    rateStep: steps.rateStep ?? 1e-4,
    dividendYieldStep: steps.dividendYieldStep ?? 1e-5,
  };
}

/**
 * Full extended Greek set by central finite differences of `price`, re-escrowing the spot via `spotAt`
 * on every rate/time bump. Bump sizes come from {@link resolveFdSteps} (adaptive near the vol/time
 * boundaries); pass the same resolved steps to disclose them in diagnostics.
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
