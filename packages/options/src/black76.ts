/**
 * `@insiderfinance/totalfinance/options/black76` — the Black-76 model for options on forwards/futures (spec §9.3).
 *
 * Black-76 prices an option on a forward price `F` with discounting at rate `r`. Greeks are taken
 * with respect to the forward. Like the BSM facade, each function returns a plain value and throws on
 * failure; `.explain()` returns the rich envelope.
 */

import {
  type Assumptions,
  type Computed,
  type Diagnostics,
  ErrorCode,
  type OptionType,
  ensureEnum,
  ensureFinite,
  ensurePositive,
  plausibilityWarnings,
  requireArgumentObject,
  requireFiniteFields,
  finiteOrNull,
  ensureKnownKeys,
} from '@totalfinance/core';
import { brent, normalCdf, normalPdf } from '@totalfinance/math';
import {
  blackScholesExtendedGreeks,
  impliedVolatilityPriceTolerance,
  priceBoundSlack,
} from './bsm.js';
import {
  withLambdaDisclosure,
  type Facade,
  analyticAssumptions,
  facade,
  impliedVolatilityFacadePair,
} from './facade-util.js';
import type { ExtendedGreeks, Greeks } from './types.js';

const MODEL = 'black-76';
const DAYS_PER_YEAR = 365;
const OPTION_TYPES = ['call', 'put'] as const;

export interface Black76Input {
  forward: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  volatility: number;
}
export interface Black76TypedInput extends Black76Input {
  type: OptionType;
}
export interface Black76ImpliedVolatilityInput {
  price: number;
  forward: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  type: OptionType;
}
export type Black76PriceBoundsInput = Omit<Black76TypedInput, 'volatility'>;

function d1d2({
  forward: F,
  strike: K,
  timeToExpiryYears: T,
  volatility: sigma,
}: Pick<Black76Input, 'forward' | 'strike' | 'timeToExpiryYears' | 'volatility'>) {
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
  return { d1, d2: d1 - sigma * sqrtT, sqrtT };
}

/** The numeric fields of a Black-76 request, with a pasteable example for each. */
const BLACK76_FIELDS = [
  'forward',
  'strike',
  'timeToExpiryYears',
  'riskFreeRate',
  'volatility',
] as const;

/** Law 12 allowlist. */
const BLACK76_KEYS = ['type', ...BLACK76_FIELDS] as const;

const BLACK76_EXAMPLE_CALL =
  "black76Price({ type: 'call', forward: 100, strike: 105, timeToExpiryYears: 0.25, " +
  'riskFreeRate: 0.04, volatility: 0.2 })';

/** The solver's own required legs: the market plus the target `price` it inverts. */
const B76_IV_FIELDS = ['price', 'forward', 'strike', 'timeToExpiryYears', 'riskFreeRate'] as const;

const B76_IV_EXAMPLE_CALL =
  "black76ImpliedVolatility({ type: 'call', price: 2.4, forward: 100, strike: 105, " +
  'timeToExpiryYears: 0.25, riskFreeRate: 0.04 })';

const BLACK76_HINTS: Record<string, string> = {
  forward: 'the forward/futures price, not spot',
  volatility: 'annualized decimal, not 20',
  riskFreeRate: 'annualized decimal',
  timeToExpiryYears: 'in years — 0.25 is three months',
};

/**
 * @internal File-private, unchecked. The implied-vol solver below evaluates this once per Brent
 * iteration, and re-validating five fields on every bracket step buys nothing: the solver validates
 * them once at its own boundary. File-private rather than exported because `./black76` is a public
 * subpath, and an exported `…Unchecked` there would publish an unguarded pricer as API.
 */
function black76PriceUnchecked(input: Black76TypedInput): number {
  const { type, forward: F, strike: K, timeToExpiryYears: T, riskFreeRate: r } = input;
  const { d1, d2 } = d1d2(input);
  const df = Math.exp(-r * T);
  return type === 'call'
    ? df * (F * normalCdf(d1) - K * normalCdf(d2))
    : df * (K * normalCdf(-d2) - F * normalCdf(-d1));
}

/**
 * Black-76 price.
 *
 * The second seed defect named in the spec, and the same shape as the first: omitting `volatility`
 * made `sigma` `undefined`, `d1` `NaN`, and the returned price `NaN` — a success-typed wrong number.
 */
export function black76Price(input: Black76TypedInput): number {
  requireArgumentObject('black76Price', 'input', input);
  // `type` is a meaning-changing string: unvalidated garbage would silently price the other leg.
  ensureEnum(input.type, OPTION_TYPES, 'type', 'black76Price');
  ensureKnownKeys('black76Price', 'input', input, BLACK76_KEYS);
  requireFiniteFields('black76Price', input, BLACK76_FIELDS, {
    exampleCall: BLACK76_EXAMPLE_CALL,
    hints: BLACK76_HINTS,
  });
  return black76PriceUnchecked(input);
}

/** Black-76 first-order Greeks (theta/day, vega/1%, rho/1%; delta/gamma w.r.t. the forward). */
export function black76Greeks(input: Black76TypedInput): Greeks {
  requireArgumentObject('black76Greeks', 'input', input);
  const { type, forward: F, timeToExpiryYears: T, riskFreeRate: r, volatility: sigma } = input;
  ensureEnum(type, OPTION_TYPES, 'type', 'black76Greeks');
  const { d1, sqrtT } = d1d2(input);
  const df = Math.exp(-r * T);
  const pdf = normalPdf(d1);
  const price = black76Price(input);
  const delta = type === 'call' ? df * normalCdf(d1) : -df * normalCdf(-d1);
  const gamma = (df * pdf) / (F * sigma * sqrtT);
  const vegaWhole = df * F * pdf * sqrtT;
  const thetaYear = r * price - (df * F * pdf * sigma) / (2 * sqrtT);
  const rhoWhole = -T * price;
  return {
    delta,
    gamma,
    theta: thetaYear / DAYS_PER_YEAR,
    vega: vegaWhole / 100,
    rho: rhoWhole / 100,
  };
}

/**
 * Black-76 higher-order Greeks (w.r.t. the forward `F`). The forward-price derivatives (vanna, charm,
 * vomma, speed, color, zomma, veta, ultima) coincide with BSM's at `S = F`, `q = r` — Black-76 has the
 * same `d1`/`d2` and discount as that BSM instance — so they are borrowed from {@link blackScholesExtendedGreeks};
 * the forward-model-specific ones are computed directly:
 *   - `vera` = ∂rho/∂σ = ∂(−T·price)/∂σ = −T·vega,
 *   - `phi`  = 0 (the forward model has no dividend yield; carry is embedded in `F`),
 *   - `lambda` = Δ·F/V.
 * First-order fields (theta/rho) come from {@link black76Greeks}, which are the Black-76 conventions.
 */
export function black76ExtendedGreeks(input: Black76TypedInput): ExtendedGreeks {
  requireArgumentObject('black76ExtendedGreeks', 'input', input);
  const {
    type,
    forward: F,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    volatility: sigma,
  } = input;
  ensureEnum(type, OPTION_TYPES, 'type', 'black76ExtendedGreeks');
  const first = black76Greeks(input);
  const fwd = blackScholesExtendedGreeks({
    type,
    spot: F,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: r,
    volatility: sigma,
  }); // S=F, q=r ⇒ identical forward derivatives
  const { d1, sqrtT } = d1d2(input);
  const vegaRaw = Math.exp(-r * T) * F * normalPdf(d1) * sqrtT; // per 1.00 σ
  return {
    ...first,
    vanna: fwd.vanna,
    charm: fwd.charm,
    vomma: fwd.vomma,
    speed: fwd.speed,
    color: fwd.color,
    zomma: fwd.zomma,
    veta: fwd.veta,
    ultima: fwd.ultima,
    vera: -T * vegaRaw, // ∂rho/∂σ, since Black-76 rho = −T·price
    phi: 0, // no dividend yield in the forward model
    lambda: finiteOrNull((first.delta * F) / black76Price(input)), // Δ·F/V; null at V=0
  };
}

/** No-arbitrage price bounds for Black-76. */
export function black76PriceBounds(input: Black76PriceBoundsInput): {
  lower: number;
  upper: number;
} {
  requireArgumentObject('black76PriceBounds', 'input', input);
  // The same field ladder blackScholesPriceBounds runs; key closure deliberately absent —
  // bound kernels are consumed compositionally with wider structurally-typed inputs.
  requireFiniteFields(
    'black76PriceBounds',
    input,
    ['forward', 'strike', 'timeToExpiryYears', 'riskFreeRate'],
    {
      exampleCall:
        "black76PriceBounds({ type: 'call', forward: 100, strike: 105, timeToExpiryYears: 0.25, riskFreeRate: 0.04 })",
    },
  );
  const { type, forward: F, strike: K, timeToExpiryYears: T, riskFreeRate: r } = input;
  ensureEnum(type, OPTION_TYPES, 'type', 'black76PriceBounds');
  const df = Math.exp(-r * T);
  return type === 'call'
    ? { lower: Math.max(0, df * (F - K)), upper: df * F }
    : { lower: Math.max(0, df * (K - F)), upper: df * K };
}

export interface Black76ImpliedVolatilityResult {
  value: number;
  converged: boolean;
  iterations: number;
  reason?:
    | 'below_intrinsic'
    | 'above_max_bound'
    | 'price_below_resolvable'
    | 'no_bracket'
    | 'max_iterations';
}

/**
 * Solve Black-76 implied volatility. Reports failure honestly; never fabricates a value. Bounds and
 * endpoint acceptance follow the same RELATIVE-tolerance rules as the BSM kernel (see
 * {@link impliedVolatilityPriceTolerance}): a target below the σ→0 price floor fails as
 * `price_below_resolvable`, and a target at the σ→∞ upper bound as `above_max_bound`.
 */
export function black76ImpliedVolatility(
  input: Black76ImpliedVolatilityInput,
): Black76ImpliedVolatilityResult {
  requireArgumentObject('black76ImpliedVolatility', 'input', input);
  ensureEnum(input.type, OPTION_TYPES, 'type', 'black76ImpliedVolatility');
  /**
   * ONCE, BEFORE the bounds and the objective — the precondition the unchecked kernel below relies on.
   *
   * RV1 routed the Brent objective to `black76PriceUnchecked` and left a comment claiming the solver
   * "validated its own legs at the boundary". It did not: only the container and the enum were
   * checked. So `forward: "100"` reached the arithmetic through string coercion and the solver
   * returned `converged: true` with a plausible-looking 0.2197 — a silently wrong number reported as
   * a successful solve, which is the exact defect class this phase exists to kill. Omitting `strike`
   * came back as `max_iterations`, blaming the solver for a missing field.
   *
   * The bounds are computed from these fields too, so validation has to precede them, not just the
   * objective.
   */
  ensureKnownKeys('black76ImpliedVolatility', 'input', input, B76_IV_KEYS);
  requireFiniteFields('black76ImpliedVolatility', input, B76_IV_FIELDS, {
    exampleCall: B76_IV_EXAMPLE_CALL,
    hints: BLACK76_HINTS,
  });
  const { type, price, forward: F, strike: K, timeToExpiryYears: T, riskFreeRate: r } = input;
  const { lower, upper } = black76PriceBounds(input);
  if (price < lower - priceBoundSlack(lower))
    return { value: NaN, converged: false, iterations: 0, reason: 'below_intrinsic' };
  // `df·F` / `df·K` is the σ→∞ supremum, never attained — a price at it is matched by every large
  // σ, so no single σ may be reported (defect-fix wave, finding 8).
  if (price >= upper - priceBoundSlack(upper))
    return { value: NaN, converged: false, iterations: 0, reason: 'above_max_bound' };

  // Unchecked: the solver validated its own legs at the boundary; this runs per Brent iteration.
  const f = (sigma: number): number =>
    black76PriceUnchecked({
      type,
      forward: F,
      strike: K,
      timeToExpiryYears: T,
      riskFreeRate: r,
      volatility: sigma,
    }) - price;
  const lo = 1e-7;
  let hi = 5;
  const ptol = impliedVolatilityPriceTolerance(price);
  const flo = f(lo);
  if (Math.abs(flo) <= ptol) return { value: lo, converged: true, iterations: 0 };
  // Target below the model price at the lowest representable σ ⇒ no σ ≥ lo reproduces it.
  if (flo > 0)
    return { value: NaN, converged: false, iterations: 0, reason: 'price_below_resolvable' };
  let fhi = f(hi);
  let exp = 0;
  while (fhi < 0 && exp < 12) {
    hi *= 2;
    fhi = f(hi);
    exp++;
  }
  if (Math.abs(fhi) <= ptol) return { value: hi, converged: true, iterations: 0 };
  if (fhi < 0) return { value: NaN, converged: false, iterations: 0, reason: 'no_bracket' };
  const res = brent(f, lo, hi, { tolerance: 1e-12, maximumIterations: 100 });
  return res.converged
    ? { value: res.value, converged: true, iterations: res.iterations }
    : { value: NaN, converged: false, iterations: res.iterations, reason: 'max_iterations' };
}

// ---- facade ----

const B76_KEYS = ['forward', 'strike', 'timeToExpiryYears', 'riskFreeRate', 'volatility'] as const;
const B76_TYPED_KEYS = [...B76_KEYS, 'type'] as const;
/**
 * A SOLVER does not accept the quantity it solves for.
 *
 * This list used to be `[...B76_TYPED_KEYS, 'price']`, which inherited `volatility` from the PRICING
 * contract — so `black76ImpliedVolatility({ ...priced, volatility: 0.2 })` was accepted and the
 * volatility silently ignored. A caller who passes it has made a conceptual error (they think they
 * are pricing), and Law 12 exists to say so rather than return a number that answers a different
 * question. Written out rather than derived, because the derivation is what introduced the bug.
 */
const B76_IV_KEYS = [
  'type',
  'price',
  'forward',
  'strike',
  'timeToExpiryYears',
  'riskFreeRate',
] as const;

function validate(input: Black76Input, functionName: string): void {
  // Law 12 — the untyped facades (black76.call/put) own the convention; `type` is unknown here.
  ensureKnownKeys(functionName, 'input', input, B76_KEYS);
  ensurePositive(input.forward, 'forward', functionName);
  ensurePositive(input.strike, 'strike', functionName, ErrorCode.InputNegativeStrike);
  ensurePositive(
    input.timeToExpiryYears,
    'timeToExpiryYears',
    functionName,
    ErrorCode.InputNegativeTime,
  );
  ensurePositive(input.volatility, 'volatility', functionName, ErrorCode.InputNegativeVolatility);
  ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
}

function validateTyped(input: Black76TypedInput, functionName: string): void {
  ensureKnownKeys(functionName, 'input', input, B76_TYPED_KEYS);
  // `type: 'Call'` must teach, not silently price the other leg (design law #4).
  ensureEnum(input.type, OPTION_TYPES, 'type', functionName);
  const { type: _type, ...rest } = input;
  ensurePositive(rest.forward, 'forward', functionName);
  ensurePositive(rest.strike, 'strike', functionName, ErrorCode.InputNegativeStrike);
  ensurePositive(
    rest.timeToExpiryYears,
    'timeToExpiryYears',
    functionName,
    ErrorCode.InputNegativeTime,
  );
  ensurePositive(rest.volatility, 'volatility', functionName, ErrorCode.InputNegativeVolatility);
  ensureFinite(rest.riskFreeRate, 'riskFreeRate', functionName);
}

function assumptions(t: number): Assumptions {
  return analyticAssumptions({ model: MODEL, timeToExpiryYears: t });
}

function closedForm(input?: {
  volatility: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
}): Diagnostics {
  // Black-76 vol is a lognormal decimal like BSM's, so `.explain()` surfaces the same unit footguns
  // (vol as percent, t as day count) — the plain-value path stays silent-and-correct.
  return {
    engine: MODEL,
    method: 'closed-form',
    converged: true,
    warnings: input ? plausibilityWarnings(input) : [],
  };
}

function priceTyped(input: Black76TypedInput, functionName: string): number {
  validateTyped(input, functionName);
  return black76Price(input);
}

// Wrapper construction is side-effect-free; expert imports must not retain unused facades.
const call = /* @__PURE__ */ facade(
  'black76.call',
  (i: Black76Input) => (
    validate(i, 'black76.call'),
    priceTyped({ ...i, type: 'call' }, 'black76.call')
  ),
  (i: Black76Input): Computed<number> => (
    validate(i, 'black76.call'),
    {
      value: priceTyped({ ...i, type: 'call' }, 'black76.call'),
      assumptions: assumptions(i.timeToExpiryYears),
      diagnostics: closedForm({
        volatility: i.volatility,
        timeToExpiryYears: i.timeToExpiryYears,
        riskFreeRate: i.riskFreeRate,
      }),
    }
  ),
);
const put = /* @__PURE__ */ facade(
  'black76.put',
  (i: Black76Input) => (
    validate(i, 'black76.put'),
    priceTyped({ ...i, type: 'put' }, 'black76.put')
  ),
  (i: Black76Input): Computed<number> => (
    validate(i, 'black76.put'),
    {
      value: priceTyped({ ...i, type: 'put' }, 'black76.put'),
      assumptions: assumptions(i.timeToExpiryYears),
      diagnostics: closedForm({
        volatility: i.volatility,
        timeToExpiryYears: i.timeToExpiryYears,
        riskFreeRate: i.riskFreeRate,
      }),
    }
  ),
);
const price = /* @__PURE__ */ facade(
  'black76.price',
  (i: Black76TypedInput) => priceTyped(i, 'black76.price'),
  (i: Black76TypedInput): Computed<number> => ({
    value: priceTyped(i, 'black76.price'),
    assumptions: assumptions(i.timeToExpiryYears),
    diagnostics: closedForm({
      volatility: i.volatility,
      timeToExpiryYears: i.timeToExpiryYears,
      riskFreeRate: i.riskFreeRate,
    }),
  }),
);
const greeks = /* @__PURE__ */ facade(
  'black76.greeks',
  (i: Black76TypedInput): Greeks => {
    validateTyped(i, 'black76.greeks');
    return black76Greeks(i);
  },
  (i: Black76TypedInput): Computed<Greeks> => {
    validateTyped(i, 'black76.greeks');
    return {
      value: black76Greeks(i),
      assumptions: assumptions(i.timeToExpiryYears),
      diagnostics: closedForm({
        volatility: i.volatility,
        timeToExpiryYears: i.timeToExpiryYears,
        riskFreeRate: i.riskFreeRate,
      }),
    };
  },
);
const extendedGreeks = /* @__PURE__ */ facade(
  'black76.extendedGreeks',
  (i: Black76TypedInput): ExtendedGreeks => {
    validateTyped(i, 'black76.extendedGreeks');
    return black76ExtendedGreeks(i);
  },
  (i: Black76TypedInput): Computed<ExtendedGreeks> => {
    validateTyped(i, 'black76.extendedGreeks');
    const value = black76ExtendedGreeks(i);
    return {
      value,
      assumptions: assumptions(i.timeToExpiryYears),
      diagnostics: withLambdaDisclosure(
        closedForm({
          volatility: i.volatility,
          timeToExpiryYears: i.timeToExpiryYears,
          riskFreeRate: i.riskFreeRate,
        }),
        value,
      ),
    };
  },
);

function impliedVolatilityExplain(i: Black76ImpliedVolatilityInput): Computed<number | null> {
  // Law 12 at the SHARED entry, so the plain facade and `.explain()` reject identically.
  ensureKnownKeys('black76.impliedVolatility', 'input', i, B76_IV_KEYS);
  ensureEnum(i.type, OPTION_TYPES, 'type', 'black76.impliedVolatility');
  ensurePositive(i.price, 'price', 'black76.impliedVolatility');
  ensurePositive(i.forward, 'forward', 'black76.impliedVolatility');
  ensurePositive(i.strike, 'strike', 'black76.impliedVolatility', ErrorCode.InputNegativeStrike);
  ensurePositive(
    i.timeToExpiryYears,
    'timeToExpiryYears',
    'black76.impliedVolatility',
    ErrorCode.InputNegativeTime,
  );
  ensureFinite(i.riskFreeRate, 'riskFreeRate', 'black76.impliedVolatility');
  const res = black76ImpliedVolatility(i);
  const a = assumptions(i.timeToExpiryYears);
  // No vol input here, but the day-count-as-year-fraction footgun on `t` still deserves a flag.
  const suspicious = plausibilityWarnings({
    timeToExpiryYears: i.timeToExpiryYears,
    riskFreeRate: i.riskFreeRate,
  });
  if (res.converged) {
    return {
      value: res.value,
      assumptions: a,
      diagnostics: {
        engine: MODEL,
        method: 'brent',
        converged: true,
        iterations: res.iterations,
        warnings: suspicious,
      },
    };
  }
  const code =
    res.reason === 'below_intrinsic'
      ? ErrorCode.ImpliedVolatilityBelowIntrinsic
      : res.reason === 'above_max_bound'
        ? ErrorCode.ImpliedVolatilityAboveMax
        : res.reason === 'price_below_resolvable'
          ? ErrorCode.ImpliedVolatilityPriceBelowResolvable
          : ErrorCode.ImpliedVolatilityNoConvergence;
  return {
    value: null,
    assumptions: a,
    diagnostics: {
      engine: MODEL,
      method: 'brent',
      converged: false,
      iterations: res.iterations,
      warnings: [
        { code, message: `Black-76 implied vol failed (${res.reason})`, severity: 'error' },
        ...suspicious,
      ],
    },
  };
}

/** The Black-76 facade namespace. */
export const black76: {
  call: Facade<Black76Input, number>;
  put: Facade<Black76Input, number>;
  price: Facade<Black76TypedInput, number>;
  greeks: Facade<Black76TypedInput, Greeks>;
  extendedGreeks: Facade<Black76TypedInput, ExtendedGreeks>;
  impliedVolatility: Facade<
    Black76ImpliedVolatilityInput,
    number,
    Record<never, never>,
    number | null
  >;
} = /* @__PURE__ */ (() => ({
  call,
  put,
  price,
  greeks,
  extendedGreeks,
  impliedVolatility: impliedVolatilityFacadePair(
    'black76.impliedVolatility',
    impliedVolatilityExplain,
    [ErrorCode.ImpliedVolatilityBelowIntrinsic, ErrorCode.ImpliedVolatilityAboveMax],
    'implied vol did not converge',
  ),
}))();
