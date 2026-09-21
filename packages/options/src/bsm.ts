/**
 * The pure Black–Scholes–Merton kernel (spec §9.3 analytical engine).
 *
 * These functions assume already-validated inputs (S, K, T, σ all > 0). They are the single source
 * of truth for BSM math: the facade, the pro API, the engines, and the MCP server all route here —
 * no duplicate implementations (spec §18.1).
 */

import {
  type OptionType,
  ensureEnum,
  ensureFiniteWhenPresent,
  requireArgumentObject,
  ensureKnownKeys,
  requireFiniteFields,
  InputError,
  ErrorCode,
} from '@totalfinance/core';
import { brent, normalCdf, normalPdf } from '@totalfinance/math';
import type { ExtendedGreeks, Greeks } from './types.js';

const DAYS_PER_YEAR = 365;

/**
 * The numeric inputs are trusted (kernel tier), but `type` is a meaning-changing STRING: an
 * unvalidated `'Call'`/`'garbage'` would silently fall through `type === 'call' ? … : …` and price
 * the OTHER leg (design law #4). Every public kernel validates it — two string compares, hot-path
 * safe.
 */
const OPTION_TYPES = ['call', 'put'] as const;

interface D1D2 {
  d1: number;
  d2: number;
  sqrtT: number;
  /** Discount factor e^{-rT}. */
  discountFactor: number;
  /** Dividend discount e^{-qT}. */
  dq: number;
}

export interface BlackScholesPriceBoundsInput {
  type: OptionType;
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
}

export interface BlackScholesKernelInput extends BlackScholesPriceBoundsInput {
  volatility: number;
}

function d1d2(input: Omit<BlackScholesKernelInput, 'type'>): D1D2 {
  const {
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
  } = input;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return { d1, d2, sqrtT, discountFactor: Math.exp(-r * T), dq: Math.exp(-q * T) };
}

/**
 * The numeric fields every Black–Scholes input must carry, and a worked example for each — the
 * example is what turns "dividendYield is required" into a fix the caller can paste.
 */
const BSM_FIELDS = [
  'spot',
  'strike',
  'timeToExpiryYears',
  'riskFreeRate',
  'dividendYield',
  'volatility',
] as const;

/** Law 12 allowlist: the numeric legs plus the `type` discriminant. */
const BSM_KEYS = ['type', ...BSM_FIELDS] as const;

/** The solver's own required legs: the market plus the target `price` it is inverting. */
const IV_SOLVER_KEYS = [
  'type',
  'price',
  'spot',
  'strike',
  'timeToExpiryYears',
  'riskFreeRate',
  'dividendYield',
  'lowerVolatilityBound',
  'upperVolatilityBound',
] as const;

const IV_SOLVER_FIELDS = [
  'price',
  'spot',
  'strike',
  'timeToExpiryYears',
  'riskFreeRate',
  'dividendYield',
] as const;

/**
 * ONE runnable call, and per-field hints for the traps a call shape cannot carry.
 *
 * The example used to be a fragment (`volatility: 0.2 (annualized decimal, not 20)`) — informative,
 * but `missingFieldError` promises "a WORKING example call" and the rest of the library delivers one
 * (`sma(closes, { period: 20 })`, `walkForward({ data, trainSize: 30, … })`). A caller who is
 * confused about the request shape is precisely the one who cannot assemble it from a snippet.
 */
const BSM_EXAMPLE_CALL =
  "blackScholesPrice({ type: 'call', spot: 100, strike: 105, timeToExpiryYears: 0.25, " +
  'riskFreeRate: 0.04, dividendYield: 0, volatility: 0.2 })';

const BSM_GREEKS_EXAMPLE_CALL =
  "blackScholesGreeks({ type: 'call', spot: 100, strike: 105, timeToExpiryYears: 0.25, " +
  'riskFreeRate: 0.04, dividendYield: 0, volatility: 0.2 })';

const BSM_BOUNDS_FIELDS = [
  'spot',
  'strike',
  'timeToExpiryYears',
  'riskFreeRate',
  'dividendYield',
] as const;
const BSM_BOUNDS_EXAMPLE_CALL =
  "blackScholesPriceBounds({ type: 'call', spot: 100, strike: 105, timeToExpiryYears: 0.25, " +
  'riskFreeRate: 0.04, dividendYield: 0 })';

const IV_EXAMPLE_CALL =
  "blackScholesImpliedVolatility({ type: 'call', price: 2.4, spot: 100, strike: 105, " +
  'timeToExpiryYears: 0.25, riskFreeRate: 0.04, dividendYield: 0 })';

const BSM_HINTS: Record<string, string> = {
  volatility: 'annualized decimal, not 20',
  riskFreeRate: 'annualized decimal',
  dividendYield: 'annualized decimal; 0 when the underlying pays none',
  timeToExpiryYears: 'in years — 0.25 is three months, not 90',
};

/**
 * The unchecked kernel: pure arithmetic, no validation.
 *
 * It exists so validation can live at the boundary WITHOUT being paid per row. `blackScholesPriceManyInto`
 * validates its columns once and then runs this 100,000 times; routing that loop through the public
 * facade would re-check six fields per row for no added safety, which spec 3B.1b forbids outright.
 *
 * @internal PACKAGE-private, not file-private: `batch.ts` is its one legitimate caller and the package
 * index deliberately does not re-export it, so it never reaches the public surface or the API report.
 * The contract it must keep is that every path reaching it has already been validated — a caller that
 * forgets is exactly the seed defect, reintroduced one layer down.
 */
export function blackScholesPriceUnchecked(input: BlackScholesKernelInput): number {
  const { type, spot: S, strike: K } = input;
  const { d1, d2, discountFactor, dq } = d1d2(input);
  if (type === 'call') return S * dq * normalCdf(d1) - K * discountFactor * normalCdf(d2);
  return K * discountFactor * normalCdf(-d2) - S * dq * normalCdf(-d1);
}

/**
 * Black–Scholes–Merton price for a European call/put with continuous dividend yield `q`.
 *
 * This is the seed defect Phase 3B was opened on. It validated the object and the `type` enum, then
 * destructured six numeric fields and checked none of them: omitting `volatility` made `sigma`
 * `undefined`, `d1` `NaN`, and the returned PRICE `NaN` — handed back as a success, through a
 * declaration that said the field was required. A pricing function that answers `NaN` is worse than
 * one that throws, because every layer above it treats the answer as a number.
 */
export function blackScholesPrice(input: BlackScholesKernelInput): number {
  requireArgumentObject('blackScholesPrice', 'input', input);
  ensureEnum(input.type, OPTION_TYPES, 'type', 'blackScholesPrice');
  // Law 12 / the FIRST named seed defect: `{ ...valid, dividendYeild: 0.01 }` was accepted and
  // priced with the default, silently ignoring the field the caller thought they set.
  ensureKnownKeys('blackScholesPrice', 'input', input, BSM_KEYS);
  requireFiniteFields('blackScholesPrice', input, BSM_FIELDS, {
    exampleCall: BSM_EXAMPLE_CALL,
    hints: BSM_HINTS,
  });
  return blackScholesPriceUnchecked(input);
}

/** First-order Greeks in TotalFinance default units (theta/day, vega/1%, rho/1%). */
export function blackScholesGreeks(input: BlackScholesKernelInput): Greeks {
  requireArgumentObject('blackScholesGreeks', 'input', input);
  // The same field ladder blackScholesPrice runs (3B.1b seed defects): a greeks request with a
  // missing or null leg used to return a full Greeks object of NaN as if it had succeeded. Key
  // closure is deliberately absent — like the bounds kernel, greeks is consumed compositionally
  // (extendedGreeks, engines) with wider structurally-typed inputs.
  requireFiniteFields('blackScholesGreeks', input, BSM_FIELDS, {
    exampleCall: BSM_GREEKS_EXAMPLE_CALL,
    hints: BSM_HINTS,
  });
  const {
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
  } = input;
  ensureEnum(type, OPTION_TYPES, 'type', 'blackScholesGreeks');
  const { d1, d2, sqrtT, discountFactor, dq } = d1d2(input);
  const pdfD1 = normalPdf(d1);

  const delta = type === 'call' ? dq * normalCdf(d1) : -dq * normalCdf(-d1);
  const gamma = (dq * pdfD1) / (S * sigma * sqrtT);
  const vegaPerWhole = S * dq * pdfD1 * sqrtT; // per 1.00 change in σ
  const rhoPerWhole =
    type === 'call'
      ? K * T * discountFactor * normalCdf(d2)
      : -K * T * discountFactor * normalCdf(-d2); // per 1.00 change in r

  const thetaPerYear =
    type === 'call'
      ? -(S * dq * pdfD1 * sigma) / (2 * sqrtT) -
        r * K * discountFactor * normalCdf(d2) +
        q * S * dq * normalCdf(d1)
      : -(S * dq * pdfD1 * sigma) / (2 * sqrtT) +
        r * K * discountFactor * normalCdf(-d2) -
        q * S * dq * normalCdf(-d1);

  return {
    delta,
    gamma,
    theta: thetaPerYear / DAYS_PER_YEAR,
    vega: vegaPerWhole / 100,
    rho: rhoPerWhole / 100,
  };
}

/**
 * Higher-order Greeks under BSM (spec §9.4), analytic and exact. First-order fields (`delta`…`rho`)
 * carry the same default units as {@link blackScholesGreeks}; the second/third-order fields are in raw units:
 *   - `vanna` = ∂Δ/∂σ = ∂²V/∂S∂σ  (per 1.00 σ, per $),
 *   - `vomma` = ∂(vega)/∂σ = ∂²V/∂σ²  (per 1.00 σ²; vega here is per 1.00 σ),
 *   - `charm` = ∂Δ/∂T  (delta drift per added year of time-to-expiry),
 *   - `speed` = ∂Γ/∂S = ∂³V/∂S³,
 *   - `color` = ∂Γ/∂T  (gamma drift per added year of time-to-expiry),
 *   - `phi`   = ε = ∂V/∂q  (dividend rho, per 1% dividend yield — scaled like rho),
 *   - `zomma` = ∂Γ/∂σ = ∂³V/∂S²∂σ,
 *   - `veta`  = ∂vega/∂T  (per year of time-to-expiry; the ∂/∂T sibling of vega),
 *   - `vera`  = ∂rho/∂σ = ∂²V/∂r∂σ,
 *   - `ultima`= ∂vomma/∂σ = ∂³V/∂σ³,
 *   - `lambda`= Δ·S/V  (elasticity / effective leverage, dimensionless).
 * All are validated against finite differences of the first-order Greeks / the price.
 */
export function blackScholesExtendedGreeks(input: BlackScholesKernelInput): ExtendedGreeks {
  requireArgumentObject('blackScholesExtendedGreeks', 'input', input);
  const {
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
  } = input;
  ensureEnum(type, OPTION_TYPES, 'type', 'blackScholesExtendedGreeks');
  const first = blackScholesGreeks(input);
  const { d1, d2, sqrtT, discountFactor, dq } = d1d2(input);
  const pdf = normalPdf(d1);
  const gamma = (dq * pdf) / (S * sigma * sqrtT);
  const vegaRaw = S * dq * pdf * sqrtT; // per 1.00 σ

  // ∂d1/∂T (shared by charm and color).
  const dd1dT = (2 * (r - q) * T - d2 * sigma * sqrtT) / (2 * T * sigma * sqrtT);

  const vanna = (-dq * pdf * d2) / sigma; // ∂d1/∂σ = -d2/σ
  const vomma = (vegaRaw * d1 * d2) / sigma;
  const speed = -(gamma / S) * (d1 / (sigma * sqrtT) + 1);
  const charm =
    type === 'call'
      ? -q * dq * normalCdf(d1) + dq * pdf * dd1dT
      : q * dq * normalCdf(-d1) + dq * pdf * dd1dT;
  const color = gamma * (-q - d1 * dd1dT - 1 / (2 * T));

  // Dividend rho (ε): ∂V/∂q, scaled per 1% like rho.
  const phi = (type === 'call' ? -S * T * dq * normalCdf(d1) : S * T * dq * normalCdf(-d1)) / 100;
  const zomma = (gamma * (d1 * d2 - 1)) / sigma; // ∂Γ/∂σ
  // ∂vega/∂T (time-to-expiry convention, matching charm/color = −∂vega/∂t_calendar).
  const veta = -vegaRaw * (q + ((r - q) * d1) / (sigma * sqrtT) - (1 + d1 * d2) / (2 * T));
  const vera = -K * T * discountFactor * normalPdf(d2) * (d1 / sigma); // ∂rho/∂σ (raw, per 1.00 r per 1.00 σ)
  const ultima = (-vegaRaw / (sigma * sigma)) * (d1 * d2 * (1 - d1 * d2) + d1 * d1 + d2 * d2);
  // Δ·S/V elasticity — undefined (null) when V underflows to 0; the raw division would be ±∞/NaN.
  const lambdaRaw = (first.delta * S) / blackScholesPrice(input);
  const lambda = Number.isFinite(lambdaRaw) ? lambdaRaw : null;

  return { ...first, vanna, charm, vomma, speed, color, phi, zomma, veta, vera, ultima, lambda };
}

/** No-arbitrage price bounds for a vanilla under BSM (forward intrinsic ≤ price ≤ discounted spot/strike). */
export function blackScholesPriceBounds(input: BlackScholesPriceBoundsInput): {
  lower: number;
  upper: number;
} {
  requireArgumentObject('blackScholesPriceBounds', 'input', input);
  // NO ensureKnownKeys here, deliberately: this bound kernel is consumed COMPOSITIONALLY — the IV
  // solver hands it its own wider input (with `price`), which structural typing blesses. The field
  // ladder below still rejects a missing or null leg; key closure belongs to the outer boundary.
  requireFiniteFields('blackScholesPriceBounds', input, BSM_BOUNDS_FIELDS, {
    exampleCall: BSM_BOUNDS_EXAMPLE_CALL,
    hints: BSM_HINTS,
  });
  const {
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
  } = input;
  ensureEnum(type, OPTION_TYPES, 'type', 'blackScholesPriceBounds');
  const df = Math.exp(-r * T);
  const dq = Math.exp(-q * T);
  if (type === 'call') return { lower: Math.max(0, S * dq - K * df), upper: S * dq };
  return { lower: Math.max(0, K * df - S * dq), upper: K * df };
}

export type ImpliedVolatilityReason =
  | 'below_intrinsic'
  | 'above_max_bound'
  /**
   * The target premium is smaller than the model price at the lowest σ the solver represents, so no
   * volatility in the bracket reproduces it (the σ→0 floor sits ABOVE the target). Distinct from
   * `below_intrinsic` (a no-arbitrage violation) and from `no_bracket` (a bracketing failure with a
   * root that exists): here the inverse simply has no solution at this price scale.
   */
  | 'price_below_resolvable'
  | 'no_bracket'
  | 'max_iterations';

export interface BlackScholesImpliedVolatilityResult {
  value: number;
  converged: boolean;
  iterations: number;
  error?: number;
  reason?: ImpliedVolatilityReason;
}

export interface BlackScholesImpliedVolatilityOptions {
  /** Lower σ bracket (default `1e-7`). */
  lowerVolatilityBound?: number;
  /** Upper σ bracket before expansion (default `5`). */
  upperVolatilityBound?: number;
}

export interface BlackScholesImpliedVolatilityKernelInput
  extends BlackScholesPriceBoundsInput, BlackScholesImpliedVolatilityOptions {
  price: number;
}

/**
 * Slack for comparing a target premium against a no-arbitrage price BOUND. Relative to the bound,
 * never a bare absolute epsilon: at `S = 1e6` an absolute `1e-12` sits far below float noise, and at
 * `S = 1e-3` it is a large fraction of the whole price scale. Shared by the three IV kernels and the
 * method suite so every entry point draws the bounds in the same place.
 */
export function priceBoundSlack(bound: number): number {
  return 1e-12 * Math.max(1, Math.abs(bound));
}

/**
 * Acceptance tolerance for "the model price at this σ IS the target price".
 *
 * RELATIVE to the target (1e-8 of it), floored only at the IEEE-754 limit. An ABSOLUTE tolerance
 * (`1e-8·max(1, price)`) silently turns into "any price ≤ 1e-8 matches anything": a 1e-8 target is
 * "reproduced" by the σ = lo bracket endpoint, so the solver reports `converged: true` with an
 * arbitrary volatility, and a target 1% larger falls off a cliff into a completely different σ. A
 * relative tolerance makes the endpoint acceptance mean what it says — the endpoint is a genuine
 * root — at every price scale (defect-fix wave, finding 1).
 */
export function impliedVolatilityPriceTolerance(price: number): number {
  return Math.max(1e-8 * Math.abs(price), Number.MIN_VALUE);
}

/**
 * Solve implied volatility from a price using Brent with no-arbitrage bound checks.
 *
 * Returns `converged: false` with a machine-readable `reason` on failure — never a fabricated value
 * (design law #4). Three ways there is no answer, reported apart: the price violates the intrinsic
 * floor (`below_intrinsic`), it sits at or above the upper no-arbitrage bound, which is a SUPREMUM
 * attained only as σ→∞ (`above_max_bound`), or it is below the model price at the lowest σ in the
 * bracket (`price_below_resolvable`).
 */
export function blackScholesImpliedVolatility(
  input: BlackScholesImpliedVolatilityKernelInput,
): BlackScholesImpliedVolatilityResult {
  requireArgumentObject('blackScholesImpliedVolatility', 'input', input);
  const {
    type,
    price,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    lowerVolatilityBound,
    upperVolatilityBound,
  } = input;
  ensureEnum(type, OPTION_TYPES, 'type', 'blackScholesImpliedVolatility');
  /**
   * ONCE, at the boundary — this is what lets the Brent objective below call the UNCHECKED kernel.
   *
   * The solver previously validated only the container and the enum, and its objective re-validated
   * six fields on every bracket step. Routing the objective to the unchecked kernel without this line
   * would be the seed defect one layer down: a missing `spot` would reach the arithmetic and the
   * solver would iterate on `NaN`.
   */
  // Law 12 here as well: a misspelled `dividendYeild` on a SOLVER silently inverts against the
  // default and reports `converged: true`, which reads as an answer rather than a typo.
  ensureKnownKeys('blackScholesImpliedVolatility', 'input', input, IV_SOLVER_KEYS);
  requireFiniteFields('blackScholesImpliedVolatility', input, IV_SOLVER_FIELDS, {
    exampleCall: IV_EXAMPLE_CALL,
    hints: BSM_HINTS,
  });
  /**
   * The OPTIONAL bracket endpoints get the same treatment when supplied.
   *
   * `lowerVolatilityBound: '0.1'` was accepted and the solve returned `reason: 'max_iterations'` — the
   * bracket comparison against a string is silently false, so the search never narrows and the
   * failure is reported against the SOLVER rather than the input that broke it. Optional means "you
   * may omit it", never "you may pass anything".
   */
  ensureFiniteWhenPresent(
    input.lowerVolatilityBound,
    'lowerVolatilityBound',
    'blackScholesImpliedVolatility',
  );
  ensureFiniteWhenPresent(
    input.upperVolatilityBound,
    'upperVolatilityBound',
    'blackScholesImpliedVolatility',
  );
  const lo = lowerVolatilityBound ?? 1e-7;
  let hi = upperVolatilityBound ?? 5;
  /**
   * The bracket must be a VOLATILITY INTERVAL, checked after defaults are applied and BEFORE any
   * result is returned.
   *
   * Finiteness alone let three broken brackets through, each failing differently and none of them
   * saying what was wrong:
   *
   *     lowerVolatilityBound: -0.1            -> converged: true, a plausible positive IV
   *     lowerVolatilityBound: 0               -> converged: true (or `max_iterations`, depending on the quote)
   *     lowerVolatilityBound: 0.3, hi: 0.1    -> `price_below_resolvable`
   *
   * The first is the serious one: σ < 0 has no meaning in this model, and the solver answered anyway
   * because the search never visits the endpoint it was handed. The others blame the solver or the
   * market for a malformed argument. Checked on the EFFECTIVE bounds, so `lowerVolatilityBound: 10` against
   * the default `hi = 5` is caught too — a half-specified bracket can be reversed just as easily as
   * a fully specified one.
   *
   * ORDER IS PART OF THE FIX. RV6 put this check where the bracket variables happened to be defined,
   * which is below the below-intrinsic and above-bound exits — so a malformed bracket paired with a
   * price outside the no-arbitrage band returned `reason: 'below_intrinsic'`, a statement ABOUT THE
   * MARKET, for a call that was never valid enough to have one. A caller who mistyped a bound was
   * told their premium was too cheap. Argument validity is a precondition of every result this
   * function can produce, including the ones that look like early exits, so it runs before all of
   * them.
   */
  if (!(lo > 0 && hi > lo)) {
    throw new InputError(
      `blackScholesImpliedVolatility: the volatility bracket must satisfy 0 < lowerVolatilityBound < ` +
        `upperVolatilityBound; got lowerVolatilityBound=${lo}, upperVolatilityBound=${hi}.` +
        `\n  e.g. ${IV_EXAMPLE_CALL.slice(0, -2)}, lowerVolatilityBound: 0.01, upperVolatilityBound: 3 })`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: 'blackScholesImpliedVolatility',
          lowerVolatilityBound: lo,
          upperVolatilityBound: hi,
        },
      },
    );
  }

  const { lower, upper } = blackScholesPriceBounds(input);
  if (price < lower - priceBoundSlack(lower)) {
    return { value: NaN, converged: false, iterations: 0, reason: 'below_intrinsic' };
  }
  // The upper bound is a SUPREMUM (`S·e^{−qT}` / `K·e^{−rT}` is the σ→∞ limit, never attained): a
  // price AT it is reproduced identically by every large σ, so any single σ reported would be
  // fabricated — σ ≈ 40 was what the expanded bracket happened to stop at. Reject as above-max
  // instead (defect-fix wave, finding 8).
  if (price >= upper - priceBoundSlack(upper)) {
    return { value: NaN, converged: false, iterations: 0, reason: 'above_max_bound' };
  }

  // Unchecked: every field was validated at the boundary above, and this runs per Brent iteration.
  const f = (sigma: number): number =>
    blackScholesPriceUnchecked({
      type,
      spot: S,
      strike: K,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
      volatility: sigma,
    }) - price;

  // Endpoint acceptance: when the target matches the model price at a bracket endpoint to within a
  // RELATIVE tolerance, that endpoint's volatility is a legitimate root (deep ITM/OTM contracts
  // whose time value sits below machine precision have their IV pinned at the endpoint). The
  // tolerance is relative so this stays "the endpoint IS the root" at every price scale.
  const ptol = impliedVolatilityPriceTolerance(price);

  const flo = f(lo);
  if (Math.abs(flo) <= ptol) {
    return { value: lo, converged: true, iterations: 0, error: Math.abs(flo) };
  }
  if (flo > 0) {
    // The model price at the LOWEST representable σ already exceeds the target, so no σ ≥ lo
    // reproduces it: the target is below the solver's resolvable price floor. Reporting `lo` here
    // (what an absolute tolerance did for every target ≤ 1e-8) is a fabricated volatility.
    return {
      value: NaN,
      converged: false,
      iterations: 0,
      error: flo,
      reason: 'price_below_resolvable',
    };
  }

  /**
   * An EXPLICIT upper bound is a bound. A defaulted one is a starting point.
   *
   * The expansion below doubles `hi` up to twelve times, and it used to run whichever way the value
   * arrived — so `upperVolatilityBound: 0.2` on a contract priced at σ = 1 returned
   * `{ value: 1.0000, converged: true }`. The caller stated a ceiling, the solver walked through it
   * by a factor of 4,096, and reported success. A field named `...Bound` that the search steps over
   * is worse than no field: the answer is outside the domain the caller said they would accept, and
   * nothing in the result says so.
   *
   * Omitted, the default 5 is this library's guess and expanding it is the right service. Supplied,
   * the number is the caller's constraint and the honest answer when no root lies under it is
   * `no_bracket` — which the existing branch below already returns.
   */
  let fhi = f(hi);
  const upperBoundIsExplicit = upperVolatilityBound !== undefined;
  let expansions = 0;
  while (fhi < 0 && !upperBoundIsExplicit && expansions < 12) {
    hi *= 2;
    fhi = f(hi);
    expansions++;
  }
  if (Math.abs(fhi) <= ptol) {
    return { value: hi, converged: true, iterations: 0, error: Math.abs(fhi) };
  }
  if (fhi < 0) {
    return { value: NaN, converged: false, iterations: 0, reason: 'no_bracket' };
  }

  const res = brent(f, lo, hi, { tolerance: 1e-12, maximumIterations: 100 });
  if (!res.converged) {
    return {
      value: NaN,
      converged: false,
      iterations: res.iterations,
      reason: 'max_iterations',
      ...(res.residual !== undefined ? { error: res.residual } : {}),
    };
  }
  return {
    value: res.value,
    converged: true,
    iterations: res.iterations,
    ...(res.residual !== undefined ? { error: res.residual } : {}),
  };
}
