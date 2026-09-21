/**
 * Short-rate models (spec §14.3): Vasicek, Cox-Ingersoll-Ross (CIR), and Hull-White (extended
 * Vasicek, fit to the initial curve) in closed form, plus a Hull-White / Black-Karasinski trinomial
 * tree for the lognormal case that has no analytic bond price.
 *
 * The analytic models expose affine discount-bond prices `P(t,T) = A·e^{−B·r}`, zero rates, the moments
 * of the short rate, and — for the Gaussian models — the analytic zero-coupon-bond option (Jamshidian)
 * that yields caplet/floorlet prices. The trinomial tree calibrates its drift to reprice the input
 * discount curve exactly (Hull-White forward induction), so Black-Karasinski inherits an
 * arbitrage-free fit. All inputs are validated; bad parameters throw (no silent degradation).
 */

import {
  ConvergenceError,
  ErrorCode,
  InputError,
  type QuantWarning,
  ensureKnownKeys,
  ensureNonNegative,
  requireArgumentObject,
  requireFiniteFields,
  warning,
} from '@totalfinance/core';
import { brent, normalCdf } from '@totalfinance/math';
import type { YieldCurve } from './curves.js';

/**
 * Hard cap on trinomial-lattice steps (2026-08-23 review, P0): the tree's width grows with steps
 * (jmax ∝ steps at a fixed horizon), so build + rollback cost is ~O(steps²) node visits of
 * exp()-heavy math. 10,000 steps ≈ up to 10^8 visits — single-digit seconds on a laptop, 200× the
 * 50-step default, and far past the O(1/steps) convergence of the discretization.
 */
const MAX_TREE_STEPS = 10_000;

function requirePositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new InputError(`${name} must be a positive finite number (got ${value}).`, {
      code: ErrorCode.InputOutOfRange,
      context: { field: name, value },
    });
  }
}

/**
 * Curve-fitted models take a curve INSTANCE (from `curves.fromZeroRates(...)` / `curves.flat(...)` /
 * `curves.bootstrap(...)`), not a raw object. A `{}` would die on the first `discount()` call —
 * either immediately (the tree calibrates eagerly) or, worse, later inside a returned model method —
 * so teach the fix at the construction boundary.
 */
function requireCurveArg(functionName: string, curve: unknown): asserts curve is YieldCurve {
  requireArgumentObject(functionName, 'curve', curve);
  const c = curve as { discount?: unknown; instantaneousForward?: unknown };
  if (typeof c.discount !== 'function' || typeof c.instantaneousForward !== 'function') {
    throw new InputError(
      `${functionName}: curve must be a yield curve built by curves.fromZeroRates(...) / curves.flat(...) / ` +
        `curves.bootstrap(...) (an object with discount()/instantaneousForward()). ` +
        `Build the curve first, then pass it here.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field: 'curve' } },
    );
  }
  // Curves are structurally typed artifacts; consumers may attach provenance or calibration IDs.
  // Validate only the methods this model actually consumes.
}

// ---------------------------------------------------------------------------------------------------
// Vasicek
// ---------------------------------------------------------------------------------------------------

export interface VasicekParameters {
  /** Mean-reversion speed (> 0). */
  a: number;
  /** Long-run mean level. */
  b: number;
  /** Instantaneous volatility (> 0). */
  sigma: number;
  /** Current short rate. */
  r0: number;
}

export interface ShortRateMoments {
  mean: number;
  variance: number;
  standardDeviation: number;
}

export interface ShortRateModel {
  /** Affine discount-bond price `P(t,T)` for a short rate `r` at time `t` (τ = T − t in years). */
  discountBond(shortRate: number, tau: number): number;
  /** Continuously-compounded zero rate `−ln P / τ`. */
  zeroRate(shortRate: number, tau: number): number;
  /** Mean/variance of the short rate at horizonYears `T` (years), from `r0`. */
  shortRateMoments(years: number): ShortRateMoments;
}

/** Inputs shared by Gaussian zero-coupon-bond option methods. */
export interface ZeroCouponBondOptionInput {
  optionMaturity: number;
  bondMaturity: number;
  strike: number;
  right: 'call' | 'put';
}

/** Inputs shared by Gaussian caplet and floorlet methods. */
export interface RateOptionletInput {
  optionMaturity: number;
  bondMaturity: number;
  strikeRate: number;
  accrualFraction: number;
}

export interface GaussianShortRateModel extends ShortRateModel {
  /**
   * Analytic price of a European call/put on a zero-coupon bond maturing at `tBond`, exercised at
   * `tOption` (years), struck at `strike` (per unit face) — the Jamshidian decomposition's building
   * block. Returns a present value as of t = 0.
   */
  zeroCouponBondOption(input: ZeroCouponBondOptionInput): number;
  /** Caplet on the simple rate over `[tOption, tBond]`, strike `capRate`, per unit notional. */
  caplet(input: RateOptionletInput): number;
  /** Floorlet on the simple rate over `[tOption, tBond]`, strike `floorRate`, per unit notional. */
  floorlet(input: RateOptionletInput): number;
}

function vasicekB(a: number, tau: number): number {
  return (1 - Math.exp(-a * tau)) / a;
}

/** Construct a Vasicek model `dr = a(b − r)dt + σ dW`. */
export function vasicek(parameters: VasicekParameters): GaussianShortRateModel {
  requireArgumentObject('vasicek', 'parameters', parameters);
  ensureKnownKeys('vasicek', 'parameters', parameters, ['a', 'b', 'sigma', 'r0']);
  requireFiniteFields('vasicek', parameters, ['a', 'b', 'sigma', 'r0'], {
    exampleCall: 'vasicek({ a: 0.2, b: 0.04, sigma: 0.01, r0: 0.03 })',
  });
  requireArgumentObject('vasicek', 'parameters', parameters);
  const { a, b, sigma, r0 } = parameters;
  requirePositive('a', a);
  requirePositive('sigma', sigma);

  const discountBond = (r: number, tau: number): number => {
    if (tau <= 0) return 1;
    const B = vasicekB(a, tau);
    const lnA =
      ((B - tau) * (a * a * b - 0.5 * sigma * sigma)) / (a * a) - (sigma * sigma * B * B) / (4 * a);
    return Math.exp(lnA - B * r);
  };
  const p0 = (tau: number): number => discountBond(r0, tau);

  const zeroCouponBondOption = ({
    optionMaturity: tOption,
    bondMaturity: tBond,
    strike,
    right,
  }: ZeroCouponBondOptionInput): number => {
    if (tBond <= tOption) {
      throw new InputError('vasicek.zeroCouponBondOption requires bondMaturity > optionMaturity.', {
        code: ErrorCode.InputOutOfRange,
        context: { optionMaturity: tOption, bondMaturity: tBond },
      });
    }
    const sigmaP =
      sigma * vasicekB(a, tBond - tOption) * Math.sqrt((1 - Math.exp(-2 * a * tOption)) / (2 * a));
    const pB = p0(tBond);
    const pO = p0(tOption);
    if (sigmaP <= 0) {
      const intrinsic =
        right === 'call' ? Math.max(pB - strike * pO, 0) : Math.max(strike * pO - pB, 0);
      return intrinsic;
    }
    const h = Math.log(pB / (pO * strike)) / sigmaP + sigmaP / 2;
    return right === 'call'
      ? pB * normalCdf(h) - strike * pO * normalCdf(h - sigmaP)
      : strike * pO * normalCdf(-h + sigmaP) - pB * normalCdf(-h);
  };

  const caplet = ({
    optionMaturity: tOption,
    bondMaturity: tBond,
    strikeRate: capRate,
    accrualFraction: dcf,
  }: RateOptionletInput): number => {
    // A caplet is (1 + capRate·τ) puts on the zero-coupon bond struck at 1/(1 + capRate·τ).
    const k = 1 / (1 + capRate * dcf);
    return (
      (1 + capRate * dcf) *
      zeroCouponBondOption({
        optionMaturity: tOption,
        bondMaturity: tBond,
        strike: k,
        right: 'put',
      })
    );
  };
  const floorlet = ({
    optionMaturity: tOption,
    bondMaturity: tBond,
    strikeRate: floorRate,
    accrualFraction: dcf,
  }: RateOptionletInput): number => {
    const k = 1 / (1 + floorRate * dcf);
    return (
      (1 + floorRate * dcf) *
      zeroCouponBondOption({
        optionMaturity: tOption,
        bondMaturity: tBond,
        strike: k,
        right: 'call',
      })
    );
  };

  return {
    discountBond,
    zeroRate: (r, tau) => -Math.log(discountBond(r, tau)) / tau,
    shortRateMoments: (t) => {
      const mean = r0 * Math.exp(-a * t) + b * (1 - Math.exp(-a * t));
      const variance = ((sigma * sigma) / (2 * a)) * (1 - Math.exp(-2 * a * t));
      return { mean, variance, standardDeviation: Math.sqrt(variance) };
    },
    zeroCouponBondOption,
    caplet,
    floorlet,
  };
}

// ---------------------------------------------------------------------------------------------------
// CIR
// ---------------------------------------------------------------------------------------------------

export interface CirParameters {
  a: number;
  b: number;
  sigma: number;
  r0: number;
}

/**
 * A CIR model plus the honest disclosure of whether its parameters keep the short rate strictly
 * positive. Structurally a {@link ShortRateModel}, so existing consumers are unaffected.
 */
export interface CirModel extends ShortRateModel {
  /** Structured warnings about the calibration (currently: the Feller condition). Always present. */
  diagnostics: { warnings: QuantWarning[] };
}

/**
 * Construct a CIR model `dr = a(b − r)dt + σ√r dW` (affine, non-negative rates).
 *
 * The Feller condition `2ab ≥ σ²` is what keeps the short rate strictly positive. Parameters that
 * violate it are perfectly ACCEPTABLE — CIR fits to real curves routinely land there, and the
 * affine bond price stays valid — but the model then puts mass at r = 0, which changes what the
 * output means. Violation is therefore disclosed (`model.feller_condition_violated`), never thrown
 * and never silently absorbed.
 */
export function cir(parameters: CirParameters): CirModel {
  requireArgumentObject('cir', 'parameters', parameters);
  // Law 12 + the field ladder: `{ r0: null }` used to flow into the affine bond price as NaN.
  ensureKnownKeys('cir', 'parameters', parameters, ['a', 'b', 'sigma', 'r0']);
  requireFiniteFields('cir', parameters, ['a', 'b', 'sigma', 'r0'], {
    exampleCall: 'cir({ a: 0.2, b: 0.04, sigma: 0.05, r0: 0.03 })',
  });
  const { a, b, sigma, r0 } = parameters;
  requirePositive('a', a);
  requirePositive('sigma', sigma);
  requirePositive('b', b);
  if (r0 < 0) {
    throw new InputError('cir: CIR requires r0 ≥ 0.', {
      code: ErrorCode.InputOutOfRange,
      context: { r0 },
    });
  }
  const gamma = Math.sqrt(a * a + 2 * sigma * sigma);
  const warnings: QuantWarning[] = [];
  if (2 * a * b < sigma * sigma) {
    warnings.push(
      warning(
        ErrorCode.ModelFellerConditionViolated,
        `CIR parameters violate the Feller condition (2ab = ${(2 * a * b).toPrecision(4)} < σ² = ` +
          `${(sigma * sigma).toPrecision(4)}): the short rate can reach 0, so simulated paths touch ` +
          'the boundary and the strictly-positive-rate interpretation no longer holds. Bond prices ' +
          'remain valid; raise a or b, or lower sigma, to restore 2ab ≥ σ².',
        'warn',
        { meanReversion: a, longRunMean: b, sigma, feller: 2 * a * b - sigma * sigma },
      ),
    );
  }

  const discountBond = (r: number, tau: number): number => {
    if (tau <= 0) return 1;
    const eg = Math.exp(gamma * tau);
    const denom = (gamma + a) * (eg - 1) + 2 * gamma;
    const B = (2 * (eg - 1)) / denom;
    const A = Math.pow(
      (2 * gamma * Math.exp(((a + gamma) * tau) / 2)) / denom,
      (2 * a * b) / (sigma * sigma),
    );
    return A * Math.exp(-B * r);
  };

  return {
    discountBond,
    zeroRate: (r, tau) => -Math.log(discountBond(r, tau)) / tau,
    shortRateMoments: (t) => {
      const mean = r0 * Math.exp(-a * t) + b * (1 - Math.exp(-a * t));
      const variance =
        r0 * ((sigma * sigma) / a) * (Math.exp(-a * t) - Math.exp(-2 * a * t)) +
        b * ((sigma * sigma) / (2 * a)) * Math.pow(1 - Math.exp(-a * t), 2);
      return { mean, variance, standardDeviation: Math.sqrt(variance) };
    },
    diagnostics: { warnings },
  };
}

// ---------------------------------------------------------------------------------------------------
// Hull-White (extended Vasicek, fit to the initial curve)
// ---------------------------------------------------------------------------------------------------

export interface HullWhiteParameters {
  a: number;
  sigma: number;
}

export interface HullWhiteDiscountBondInput {
  valuationTime: number;
  timeToMaturity: number;
  shortRate: number;
}

const DISCOUNT_BOND_FIELDS = ['valuationTime', 'timeToMaturity', 'shortRate'] as const;

const DISCOUNT_BOND_EXAMPLE_CALL =
  'hullWhite(curve, { a: 0.03, sigma: 0.01 }).discountBond({ valuationTime: 0, timeToMaturity: 5, shortRate: 0.03 })';

/**
 * G2++ needs its OWN example: it is a two-factor model with a different constructor and different
 * state (`x`/`y`, not `shortRate`). Sharing Hull-White's example told a caller who omitted
 * `timeToMaturity` on `g2pp.discountBond` to go build a one-factor Hull-White model instead.
 */
const G2PP_DISCOUNT_BOND_EXAMPLE_CALL =
  'g2pp(curve, { a: 0.03, sigma: 0.01, b: 0.1, eta: 0.008, rho: -0.7 })' +
  '.discountBond({ valuationTime: 0, timeToMaturity: 5 })';

const DISCOUNT_BOND_HINTS: Record<string, string> = {
  valuationTime: 'years from today (t)',
  timeToMaturity: 'years from t to T, i.e. T - t',
  shortRate: 'the short rate r at t, decimal',
};

/** {@link HullWhiteParameters} keys (Law 12 — mirrors the interface above; keep in sync). */
const HULL_WHITE_PARAMS_KEYS = ['a', 'sigma'] as const;

export interface HullWhiteModel {
  /** Reconstructed discount bond `P(t,T)` consistent with the initial curve, given short rate `r` at t. */
  discountBond(input: HullWhiteDiscountBondInput): number;
  /** Analytic ZCB option as of t = 0 (uses the market curve directly). */
  zeroCouponBondOption(input: ZeroCouponBondOptionInput): number;
  caplet(input: RateOptionletInput): number;
  floorlet(input: RateOptionletInput): number;
  /** Standard deviation of the short rate at horizonYears `t`. */
  shortRateStandardDeviation(years: number): number;
}

/** Construct a Hull-White model `dr = (θ(t) − a·r)dt + σ dW`, with θ implied by `curve`. */
export function hullWhite(curve: YieldCurve, parameters: HullWhiteParameters): HullWhiteModel {
  requireArgumentObject('hullWhite', 'parameters', parameters);
  ensureKnownKeys('hullWhite', 'parameters', parameters, HULL_WHITE_PARAMS_KEYS);
  requireCurveArg('hullWhite', curve);
  const { a, sigma } = parameters;
  requirePositive('a', a);
  requirePositive('sigma', sigma);
  const Pm = (t: number): number => curve.discount(t);
  const fwd = (t: number): number => curve.instantaneousForward(t);
  const B = (tau: number): number => vasicekB(a, tau);

  const discountBond = (input: HullWhiteDiscountBondInput): number => {
    // A short-rate reconstruction with an absent leg returned NaN, and `P(t,T) = NaN` propagates
    // straight into every discounted cashflow above it.
    ensureKnownKeys('hullWhite.discountBond', 'input', input, DISCOUNT_BOND_FIELDS);
    requireFiniteFields('hullWhite.discountBond', input, DISCOUNT_BOND_FIELDS, {
      exampleCall: DISCOUNT_BOND_EXAMPLE_CALL,
      hints: DISCOUNT_BOND_HINTS,
    });
    const { valuationTime: t, timeToMaturity: tau, shortRate: r } = input;
    if (tau <= 0) return 1;
    const Bt = B(tau);
    const lnRatio = Math.log(Pm(t + tau) / Pm(t));
    const adj = Bt * fwd(t) - ((sigma * sigma) / (4 * a)) * (1 - Math.exp(-2 * a * t)) * Bt * Bt;
    return Math.exp(lnRatio + adj - Bt * r);
  };

  const zeroCouponBondOption = ({
    optionMaturity: tOption,
    bondMaturity: tBond,
    strike,
    right,
  }: ZeroCouponBondOptionInput): number => {
    if (tBond <= tOption) {
      throw new InputError(
        'hullWhite.zeroCouponBondOption requires bondMaturity > optionMaturity.',
        {
          code: ErrorCode.InputOutOfRange,
          context: { optionMaturity: tOption, bondMaturity: tBond },
        },
      );
    }
    const sigmaP =
      sigma * B(tBond - tOption) * Math.sqrt((1 - Math.exp(-2 * a * tOption)) / (2 * a));
    const pB = Pm(tBond);
    const pO = Pm(tOption);
    if (sigmaP <= 0) {
      return right === 'call' ? Math.max(pB - strike * pO, 0) : Math.max(strike * pO - pB, 0);
    }
    const h = Math.log(pB / (pO * strike)) / sigmaP + sigmaP / 2;
    return right === 'call'
      ? pB * normalCdf(h) - strike * pO * normalCdf(h - sigmaP)
      : strike * pO * normalCdf(-h + sigmaP) - pB * normalCdf(-h);
  };

  return {
    discountBond,
    zeroCouponBondOption,
    caplet: ({ optionMaturity, bondMaturity, strikeRate, accrualFraction }) =>
      (1 + strikeRate * accrualFraction) *
      zeroCouponBondOption({
        optionMaturity,
        bondMaturity,
        strike: 1 / (1 + strikeRate * accrualFraction),
        right: 'put',
      }),
    floorlet: ({ optionMaturity, bondMaturity, strikeRate, accrualFraction }) =>
      (1 + strikeRate * accrualFraction) *
      zeroCouponBondOption({
        optionMaturity,
        bondMaturity,
        strike: 1 / (1 + strikeRate * accrualFraction),
        right: 'call',
      }),
    shortRateStandardDeviation: (t) => sigma * Math.sqrt((1 - Math.exp(-2 * a * t)) / (2 * a)),
  };
}

// ---------------------------------------------------------------------------------------------------
// Trinomial tree (Hull-White / Black-Karasinski), calibrated to the initial curve
// ---------------------------------------------------------------------------------------------------

export type TreeModel = 'hull-white' | 'black-karasinski';

export interface ShortRateTreeOptions {
  meanReversion: number;
  sigma: number;
  /** `hull-white` (Gaussian short rate) or `black-karasinski` (lognormal short rate). */
  model: TreeModel;
  /** Tree horizonYears in years. */
  horizonYears: number;
  /** Number of time steps (default 50). */
  steps?: number;
}

/** {@link ShortRateTreeOptions} keys (Law 12 — mirrors the interface above; keep in sync). */
const SHORT_RATE_TREE_OPTIONS_KEYS = [
  'meanReversion',
  'sigma',
  'model',
  'horizonYears',
  'steps',
] as const;

export interface ShortRateTree {
  readonly model: TreeModel;
  readonly steps: number;
  readonly timeStepYears: number;
  /** Short rate at tree node `(i, j)` (time step i, level j). */
  shortRate(stepIndex: number, nodeIndex: number): number;
  /** Tree-implied discount bond price `P(0, T)` for a maturity on the time grid (years). */
  discountBond(maturity: number): number;
  /** Reference discount factors the tree was calibrated to, at each grid time. */
  readonly gridTimes: readonly number[];
  /** Map a year fraction to its grid step, validating it lands on the grid. */
  stepOf(years: number): number;
  /** Half-width of reachable levels at step `i` (nodes span `[-reach, +reach]`). */
  reachAt(stepIndex: number): number;
  /**
   * Generic backward induction from `terminalStep` to the root. `terminal(j)` seeds the value at each
   * terminal node; at every earlier node the discounted expected continuation is passed to `atNode`,
   * which returns the node value (inject cashflows, apply call/exercise via min/max). Returns the root
   * value. The engine behind callable bonds and Bermudan swaptions.
   */
  rollback(
    terminalStep: number,
    terminal: (j: number) => number,
    atNode?: (i: number, j: number, continuation: number) => number,
  ): number;
}

/**
 * Build a Hull-White / Black-Karasinski trinomial tree calibrated to `curve` via forward induction
 * (Hull's two-stage procedure). Stage 1 lays out a symmetric mean-reverting tree for the transformed
 * state `x`; stage 2 shifts each time slice by `α(t)` so the tree reprices every grid discount factor.
 * For Black-Karasinski the short rate is `exp(x)`, so `α` is solved numerically per step.
 */
export function shortRateTree(curve: YieldCurve, options: ShortRateTreeOptions): ShortRateTree {
  requireArgumentObject('shortRateTree', 'options', options);
  ensureKnownKeys('shortRateTree', 'options', options, SHORT_RATE_TREE_OPTIONS_KEYS);
  requireCurveArg('shortRateTree', curve);
  if (options.model === undefined) {
    throw new InputError(
      "shortRateTree: model is required — 'hull-white' | 'black-karasinski'. A complete call: shortRateTree(curve, { model: 'hull-white', meanReversion: 0.05, sigma: 0.01, horizonYears: 5 }).",
      { code: ErrorCode.InputMissingField, context: { field: 'model' } },
    );
  }
  if (
    options.steps !== undefined &&
    (typeof options.steps !== 'number' || !Number.isFinite(options.steps))
  ) {
    throw new InputError(
      `shortRateTree: steps must be a finite number when provided. Received ${options.steps === null ? 'null' : typeof options.steps}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'steps' } },
    );
  }
  if (
    options.model !== undefined &&
    options.model !== 'hull-white' &&
    options.model !== 'black-karasinski'
  ) {
    throw new InputError(
      `shortRateTree: model must be 'hull-white' | 'black-karasinski' when provided. Received ${options.model === null ? 'null' : JSON.stringify(options.model)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'model' } },
    );
  }
  const { meanReversion, sigma, model, horizonYears } = options;
  requirePositive('meanReversion', meanReversion);
  requirePositive('sigma', sigma);
  requirePositive('horizonYears', horizonYears);
  const steps = options.steps ?? 50;
  // Safe integer AND a work cap (2026-08-23 review, P0): steps drives the trinomial lattice, whose
  // node count grows ~quadratically (jmax ∝ steps at fixed horizon), so an "integer" of 1e308 was
  // unbounded allocation and above 2^53 a non-terminating build. 10,000 steps is up to ~10^8 node
  // visits of exp()-dominated math — single-digit seconds on a laptop and 200× the 50-step default;
  // trinomial-tree convergence is O(1/steps), long exhausted before that.
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > MAX_TREE_STEPS) {
    throw new InputError(
      `shortRateTree: steps must be a positive integer ≤ ${MAX_TREE_STEPS.toLocaleString('en-US')} — the lattice materializes O(steps × width) nodes with width growing with steps, so the cap keeps the largest tree single-digit seconds of synchronous work (the default is 50).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { steps, max: MAX_TREE_STEPS },
      },
    );
  }
  const timeStepYears = horizonYears / steps;
  const dx = sigma * Math.sqrt(3 * timeStepYears);
  const jmax = Math.max(1, Math.ceil(0.184 / (meanReversion * timeStepYears)));

  // Branching method and probabilities for level j (Hull-White trinomial), returning the three child
  // levels and their probabilities. Interior nodes branch centrally; the extremes switch to keep
  // probabilities valid under mean reversion.
  const branch = (
    j: number,
  ): { children: [number, number, number]; probs: [number, number, number] } => {
    const aj = meanReversion * j * timeStepYears;
    const aj2 = aj * aj;
    if (j === jmax) {
      // Downward branching to j, j−1, j−2.
      return {
        children: [j, j - 1, j - 2],
        probs: [7 / 6 + (aj2 - 3 * aj) / 2, -1 / 3 - aj2 + 2 * aj, 1 / 6 + (aj2 - aj) / 2],
      };
    }
    if (j === -jmax) {
      // Upward branching to j+2, j+1, j.
      return {
        children: [j + 2, j + 1, j],
        probs: [1 / 6 + (aj2 + aj) / 2, -1 / 3 - aj2 - 2 * aj, 7 / 6 + (aj2 + 3 * aj) / 2],
      };
    }
    // Central branching to j+1, j, j−1.
    return {
      children: [j + 1, j, j - 1],
      probs: [1 / 6 + (aj2 - aj) / 2, 2 / 3 - aj2, 1 / 6 + (aj2 + aj) / 2],
    };
  };

  const idx = (j: number): number => j + jmax; // shift level into array index
  const width = 2 * jmax + 1;

  // Stage 2: forward-induct Arrow-Debreu prices Q and solve the slice shift α at each step.
  const alpha: number[] = [];
  const xStar = (j: number): number => j * dx;
  const rateOf = (alphaI: number, j: number): number =>
    model === 'hull-white' ? alphaI + xStar(j) : Math.exp(alphaI + xStar(j));

  // Q[i] holds Arrow-Debreu prices over reachable levels at step i.
  let Q: number[] = new Array(width).fill(0);
  Q[idx(0)] = 1;
  let reach = 0; // current half-width of reachable levels

  const gridTimes: number[] = [];
  for (let i = 0; i <= steps; i++) gridTimes.push(i * timeStepYears);

  for (let i = 0; i < steps; i++) {
    const targetDf = curve.discount((i + 1) * timeStepYears);
    // Solve α_i so Σ_j Q(i,j)·exp(−r(α_i,j)·dt) = P(0, t_{i+1}).
    let alphaI: number;
    if (model === 'hull-white') {
      let s = 0;
      for (let j = -reach; j <= reach; j++) s += Q[idx(j)]! * Math.exp(-xStar(j) * timeStepYears);
      alphaI = Math.log(s / targetDf) / timeStepYears;
    } else {
      const f = (al: number): number => {
        let s = 0;
        for (let j = -reach; j <= reach; j++)
          s += Q[idx(j)]! * Math.exp(-Math.exp(al + xStar(j)) * timeStepYears);
        return s - targetDf;
      };
      const res = brent(f, -10, 5, { stepTolerance: 1e-12, maximumIterations: 200 });
      if (!res.converged) {
        throw new ConvergenceError(`Black-Karasinski tree calibration failed at step ${i}.`, {
          code: ErrorCode.SolverNoConvergence,
          context: { step: i, reason: res.reason },
        });
      }
      alphaI = res.value;
    }
    alpha.push(alphaI);

    // Propagate Q to step i+1.
    const nextReach = Math.min(reach + 1, jmax);
    const Qn = new Array(width).fill(0);
    for (let j = -reach; j <= reach; j++) {
      const discount = Math.exp(-rateOf(alphaI, j) * timeStepYears);
      const { children, probs } = branch(j);
      for (let c = 0; c < 3; c++) {
        Qn[idx(children[c]!)]! += Q[idx(j)]! * probs[c]! * discount;
      }
    }
    Q = Qn;
    reach = nextReach;
  }

  const shortRate = (i: number, j: number): number => {
    if (i < 0 || i > steps) {
      throw new InputError(`shortRate: Tree step ${i} out of range [0, ${steps}].`, {
        code: ErrorCode.InputOutOfRange,
        context: { i, steps },
      });
    }
    const al = i < alpha.length ? alpha[i]! : alpha[alpha.length - 1]!;
    return rateOf(al, j);
  };

  const reachAt = (k: number): number => Math.min(k, jmax);

  /** Backward induction from `terminalStep` to the root (see {@link ShortRateTree.rollback}). */
  const rollback = (
    terminalStep: number,
    terminal: (j: number) => number,
    atNode?: (i: number, j: number, continuation: number) => number,
  ): number => {
    // Safe integer (2026-08-23 review, P0): the ≤ steps bound already rejects any unsafe
    // magnitude, but the rollback loop's start index must be exact in its own right.
    if (!Number.isSafeInteger(terminalStep) || terminalStep < 0 || terminalStep > steps) {
      throw new InputError(`rollback: terminalStep ${terminalStep} out of range [0, ${steps}].`, {
        code: ErrorCode.InputOutOfRange,
        context: { terminalStep, steps },
      });
    }
    let values = new Array(width).fill(0);
    const rT = reachAt(terminalStep);
    for (let j = -rT; j <= rT; j++) values[idx(j)] = terminal(j);
    for (let i = terminalStep - 1; i >= 0; i--) {
      const r = reachAt(i);
      const next = new Array(width).fill(0);
      for (let j = -r; j <= r; j++) {
        const { children, probs } = branch(j);
        let cont = 0;
        for (let c = 0; c < 3; c++) cont += probs[c]! * values[idx(children[c]!)]!;
        cont *= Math.exp(-shortRate(i, j) * timeStepYears);
        next[idx(j)] = atNode ? atNode(i, j, cont) : cont;
      }
      values = next;
    }
    return values[idx(0)]!;
  };

  const stepOf = (t: number): number => {
    const m = Math.round(t / timeStepYears);
    if (m < 0 || m > steps || Math.abs(m * timeStepYears - t) > 1e-6 * Math.max(1, timeStepYears)) {
      throw new InputError(
        `stepOf: time ${t} must land on the tree grid (timeStepYears=${timeStepYears}).`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { timeYears: t, timeStepYears, steps },
        },
      );
    }
    return m;
  };

  // Discount bond by rolling a unit payoff back through the calibrated tree.
  const discountBond = (maturity: number): number => {
    const m = stepOf(maturity);
    if (m === 0) return 1;
    return rollback(m, () => 1);
  };

  return {
    model,
    steps,
    timeStepYears,
    shortRate,
    discountBond,
    gridTimes,
    stepOf,
    reachAt,
    rollback,
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// G2++ two-factor Gaussian model (fit to the initial curve)
// ───────────────────────────────────────────────────────────────────────────────────────────────

export interface G2ppParameters {
  /** Mean reversion of factor x. */
  a: number;
  /** Volatility of factor x. */
  sigma: number;
  /** Mean reversion of factor y. */
  b: number;
  /** Volatility of factor y. */
  eta: number;
  /** Instantaneous correlation of the two factors, in [-1, 1]. */
  rho: number;
}

export interface G2ppDiscountBondInput {
  valuationTime: number;
  timeToMaturity: number;
  x?: number;
  y?: number;
}

/** {@link G2ppParameters} keys (Law 12 — mirrors the interface above; keep in sync). */
const G2PP_PARAMS_KEYS = ['a', 'sigma', 'b', 'eta', 'rho'] as const;

export interface G2ppModel {
  /** Reconstructed discount bond `P(t,T)` given factor values `(x, y)` at `t` (default 0 ⇒ the curve). */
  discountBond(input: G2ppDiscountBondInput): number;
  /** Analytic zero-coupon-bond option as of t = 0 (Gaussian, like Hull-White but with the G2++ variance). */
  zeroCouponBondOption(input: ZeroCouponBondOptionInput): number;
  caplet(input: RateOptionletInput): number;
  floorlet(input: RateOptionletInput): number;
  /** Variance of the short rate at horizonYears `t`. */
  shortRateVariance(years: number): number;
}

/**
 * G2++ (two-additive-factor Gaussian) short-rate model `r(t) = φ(t) + x(t) + y(t)` with correlated
 * Ornstein-Uhlenbeck factors, fit to the initial `curve` (Brigo–Mercurio). Two factors give a richer,
 * de-correlating term structure of volatility than one-factor Hull-White, while keeping analytic
 * discount bonds and (Gaussian) zero-coupon-bond options. Reduces to Hull-White when `eta = 0`.
 */
export function g2pp(curve: YieldCurve, parameters: G2ppParameters): G2ppModel {
  requireArgumentObject('g2pp', 'parameters', parameters);
  ensureKnownKeys('g2pp', 'parameters', parameters, G2PP_PARAMS_KEYS);
  requireFiniteFields('g2pp', parameters, G2PP_PARAMS_KEYS, {
    exampleCall: 'g2pp(curve, { a: 0.5, sigma: 0.008, b: 0.05, eta: 0.006, rho: -0.7 })',
  });
  requireArgumentObject('g2pp', 'parameters', parameters);
  ensureKnownKeys('g2pp', 'parameters', parameters, G2PP_PARAMS_KEYS);
  requireCurveArg('g2pp', curve);
  const { a, b, sigma, eta, rho } = parameters;
  requirePositive('a', a);
  requirePositive('b', b);
  requirePositive('sigma', sigma);
  // `eta = 0` is the documented Hull-White reduction, so it must be REACHABLE: the doc promised it
  // while the guard rejected it, and a caller collapsing the second factor to compare against
  // one-factor Hull-White was told 0 is not a positive finite number. Every η-weighted term
  // (`V(τ)`'s second and cross terms, `Σₚ²`, the short-rate variance) carries η as a factor, so
  // η = 0 zeroes them cleanly — `b` stays strictly positive, so no `1/b` ever degenerates.
  ensureNonNegative(eta, 'eta', 'g2pp');
  if (rho < -1 || rho > 1) {
    throw new InputError('g2pp: rho must be in [-1, 1].', {
      code: ErrorCode.InputOutOfRange,
      context: { rho },
    });
  }
  const Pm = (t: number): number => curve.discount(t);
  const Ba = (tau: number): number => (1 - Math.exp(-a * tau)) / a;
  const Bb = (tau: number): number => (1 - Math.exp(-b * tau)) / b;

  // V(τ): variance of the integral of the short rate over a horizonYears τ (Brigo–Mercurio eq. 4.10).
  const Vtau = (tau: number): number => {
    const t1 =
      ((sigma * sigma) / (a * a)) *
      (tau + (2 / a) * Math.exp(-a * tau) - (1 / (2 * a)) * Math.exp(-2 * a * tau) - 3 / (2 * a));
    const t2 =
      ((eta * eta) / (b * b)) *
      (tau + (2 / b) * Math.exp(-b * tau) - (1 / (2 * b)) * Math.exp(-2 * b * tau) - 3 / (2 * b));
    const t3 =
      ((2 * rho * sigma * eta) / (a * b)) *
      (tau +
        (Math.exp(-a * tau) - 1) / a +
        (Math.exp(-b * tau) - 1) / b -
        (Math.exp(-(a + b) * tau) - 1) / (a + b));
    return t1 + t2 + t3;
  };

  const discountBond = (input: G2ppDiscountBondInput): number => {
    // `x`/`y` default to 0 (the curve), so only the two time legs are required.
    ensureKnownKeys('g2pp.discountBond', 'input', input, [
      'valuationTime',
      'timeToMaturity',
      'x',
      'y',
    ]);
    requireFiniteFields('g2pp.discountBond', input, ['valuationTime', 'timeToMaturity'], {
      exampleCall: G2PP_DISCOUNT_BOND_EXAMPLE_CALL,
      hints: DISCOUNT_BOND_HINTS,
    });
    for (const factor of ['x', 'y'] as const) {
      const value = input[factor];
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new InputError(
          `g2pp.discountBond: ${factor} must be a finite factor level when provided — omit it for the curve (0). Received ${value === null ? 'null' : typeof value}.`,
          { code: ErrorCode.InputWrongType, context: { field: factor } },
        );
      }
    }
    const { valuationTime: t, timeToMaturity: tau, x = 0, y = 0 } = input;
    if (tau <= 0) return 1;
    const T = t + tau;
    const A = 0.5 * (Vtau(tau) - Vtau(T) + Vtau(t)) - Ba(tau) * x - Bb(tau) * y;
    return (Pm(T) / Pm(t)) * Math.exp(A);
  };

  const zeroCouponBondOption = ({
    optionMaturity: tOption,
    bondMaturity: tBond,
    strike,
    right,
  }: ZeroCouponBondOptionInput): number => {
    if (tBond <= tOption) {
      throw new InputError('g2pp.zeroCouponBondOption requires bondMaturity > optionMaturity.', {
        code: ErrorCode.InputOutOfRange,
        context: { optionMaturity: tOption, bondMaturity: tBond },
      });
    }
    const T = tOption;
    const S = tBond;
    const sigmaP2 =
      ((sigma * sigma) / (2 * a * a * a)) *
        Math.pow(1 - Math.exp(-a * (S - T)), 2) *
        (1 - Math.exp(-2 * a * T)) +
      ((eta * eta) / (2 * b * b * b)) *
        Math.pow(1 - Math.exp(-b * (S - T)), 2) *
        (1 - Math.exp(-2 * b * T)) +
      ((2 * rho * sigma * eta) / (a * b * (a + b))) *
        (1 - Math.exp(-a * (S - T))) *
        (1 - Math.exp(-b * (S - T))) *
        (1 - Math.exp(-(a + b) * T));
    const Sigma = Math.sqrt(Math.max(0, sigmaP2));
    const pB = Pm(S);
    const pO = Pm(T);
    if (Sigma <= 0) {
      return right === 'call' ? Math.max(pB - strike * pO, 0) : Math.max(strike * pO - pB, 0);
    }
    const h = Math.log(pB / (pO * strike)) / Sigma + Sigma / 2;
    return right === 'call'
      ? pB * normalCdf(h) - strike * pO * normalCdf(h - Sigma)
      : strike * pO * normalCdf(-h + Sigma) - pB * normalCdf(-h);
  };

  return {
    discountBond,
    zeroCouponBondOption,
    caplet: ({ optionMaturity, bondMaturity, strikeRate, accrualFraction }) =>
      (1 + strikeRate * accrualFraction) *
      zeroCouponBondOption({
        optionMaturity,
        bondMaturity,
        strike: 1 / (1 + strikeRate * accrualFraction),
        right: 'put',
      }),
    floorlet: ({ optionMaturity, bondMaturity, strikeRate, accrualFraction }) =>
      (1 + strikeRate * accrualFraction) *
      zeroCouponBondOption({
        optionMaturity,
        bondMaturity,
        strike: 1 / (1 + strikeRate * accrualFraction),
        right: 'call',
      }),
    shortRateVariance: (t) =>
      ((sigma * sigma) / (2 * a)) * (1 - Math.exp(-2 * a * t)) +
      ((eta * eta) / (2 * b)) * (1 - Math.exp(-2 * b * t)) +
      ((2 * rho * sigma * eta) / (a + b)) * (1 - Math.exp(-(a + b) * t)),
  };
}
