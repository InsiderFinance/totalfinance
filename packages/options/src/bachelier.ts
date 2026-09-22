/**
 * `@insiderfinance/totalfinance/options/bachelier` — the Bachelier (normal) model (spec §9.3).
 *
 * Prices an option on a forward `F` under arithmetic Brownian motion. Volatility is a NORMAL vol in
 * price units (not a percentage), so vega is reported per 1.00 of normal vol (`units.vega: perPoint`).
 * Useful for rates and any market that quotes normal vol or can trade through zero/negative levels.
 */

import {
  type Assumptions,
  type Computed,
  type Diagnostics,
  ErrorCode,
  type GreekUnits,
  type OptionType,
  ensureEnum,
  ensureFinite,
  ensurePositive,
  plausibilityWarnings,
  InputError,
  ensureKnownKeys,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';
import { brent, normalCdf, normalPdf } from '@totalfinance/math';
import { impliedVolatilityPriceTolerance, priceBoundSlack } from './bsm.js';
import {
  withLambdaDisclosure,
  type Facade,
  analyticAssumptions,
  facade,
  impliedVolatilityFacadePair,
} from './facade-util.js';
import type { ExtendedGreeks, Greeks } from './types.js';

const MODEL = 'bachelier';
const DAYS_PER_YEAR = 365;
const OPTION_TYPES = ['call', 'put'] as const;
const UNITS: GreekUnits = { theta: 'perDay', vega: 'perPoint', rho: 'per1Percent' };

export interface BachelierInput {
  forward: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  /**
   * NORMAL (absolute) volatility in PRICE UNITS — deliberately NOT named `vol` (Law 4): the
   * lognormal decimal and the price-unit normal vol must never share a field name. `vega` is
   * reported per 1.00 of normal vol (`units.vega: perPoint`).
   */
  normalVolatility: number;
}
export interface BachelierTypedInput extends BachelierInput {
  type: OptionType;
}
export interface BachelierImpliedVolatilityInput {
  price: number;
  forward: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  type: OptionType;
}

/** Bachelier price. */
const BACHELIER_EXAMPLE_CALL =
  "bachelierPrice({ type: 'call', forward: 100, strike: 105, timeToExpiryYears: 0.25, " +
  'riskFreeRate: 0.04, normalVolatility: 20 })';

/** The normal-model solver's required legs. */
const BACHELIER_IV_FIELDS = [
  'price',
  'forward',
  'strike',
  'timeToExpiryYears',
  'riskFreeRate',
] as const;

const BACHELIER_IV_EXAMPLE_CALL =
  "bachelierImpliedVolatility({ type: 'call', price: 2.4, forward: 100, strike: 105, " +
  'timeToExpiryYears: 0.25, riskFreeRate: 0.04 })';

const BACHELIER_HINTS: Record<string, string> = {
  forward: 'the forward price, not spot',
  normalVolatility: 'PRICE units per year (Law 4) — not a lognormal decimal like 0.2',
  riskFreeRate: 'annualized decimal',
  timeToExpiryYears: 'in years',
};

/**
 * @internal File-private, unchecked. The normal-model implied-vol solver evaluates this per Brent
 * iteration; `./bachelier` is a public subpath, so this must not be exported.
 */
function bachelierPriceUnchecked(input: BachelierTypedInput): number {
  const {
    type,
    forward: F,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    normalVolatility: sigmaN,
  } = input;
  const df = Math.exp(-r * T);
  const sd = sigmaN * Math.sqrt(T);
  if (sd <= 0) return df * Math.max(0, type === 'call' ? F - K : K - F);
  const d = (F - K) / sd;
  return type === 'call'
    ? df * ((F - K) * normalCdf(d) + sd * normalPdf(d))
    : df * ((K - F) * normalCdf(-d) + sd * normalPdf(d));
}

export function bachelierPrice(input: BachelierTypedInput): number {
  requireArgumentObject('bachelierPrice', 'input', input);
  ensureEnum(input.type, OPTION_TYPES, 'type', 'bachelierPrice');
  ensureKnownKeys('bachelierPrice', 'input', input, BACHELIER_TYPED_KEYS);
  requireFiniteFields('bachelierPrice', input, BACHELIER_KEYS, {
    exampleCall: BACHELIER_EXAMPLE_CALL,
    hints: BACHELIER_HINTS,
  });
  return bachelierPriceUnchecked(input);
}

/** Bachelier first-order Greeks (vega is per 1.00 of normal vol). */
export function bachelierGreeks(input: BachelierTypedInput): Greeks {
  requireArgumentObject('bachelierGreeks', 'input', input);
  const {
    type,
    forward: F,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    normalVolatility: sigmaN,
  } = input;
  ensureEnum(type, OPTION_TYPES, 'type', 'bachelierGreeks');
  const df = Math.exp(-r * T);
  const sqrtT = Math.sqrt(T);
  const sd = sigmaN * sqrtT;
  const d = (F - K) / sd;
  const pdf = normalPdf(d);
  const price = bachelierPrice(input);
  const delta = type === 'call' ? df * normalCdf(d) : -df * normalCdf(-d);
  const gamma = (df * pdf) / sd;
  const vega = df * sqrtT * pdf; // per 1.00 of normal vol
  const thetaYear = r * price - (df * sigmaN * pdf) / (2 * sqrtT);
  const rhoWhole = -T * price;
  return { delta, gamma, theta: thetaYear / DAYS_PER_YEAR, vega, rho: rhoWhole / 100 };
}

/**
 * Bachelier (normal-model) higher-order Greeks (w.r.t. the forward `F` and the NORMAL vol `σ_N`). These
 * are the arithmetic-BM analogues of {@link blackScholesExtendedGreeks} — different formulas, since the density is
 * `φ((F−K)/σ_N√T)`, and `vega`/`vanna`/… are per 1.00 of normal vol (price units). `phi` (dividend rho)
 * is 0 (a forward model has no dividend yield); `lambda = Δ·F/V`. All validated against finite
 * differences of the first-order Greeks / the price.
 */
export function bachelierExtendedGreeks(input: BachelierTypedInput): ExtendedGreeks {
  requireArgumentObject('bachelierExtendedGreeks', 'input', input);
  const {
    type,
    forward: F,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    normalVolatility: sigmaN,
  } = input;
  ensureEnum(type, OPTION_TYPES, 'type', 'bachelierExtendedGreeks');
  const first = bachelierGreeks(input);
  const df = Math.exp(-r * T);
  const sqrtT = Math.sqrt(T);
  const sd = sigmaN * sqrtT;
  const d = (F - K) / sd;
  const pdf = normalPdf(d);
  const gamma = (df * pdf) / sd;
  const rDf = r * df;

  const vanna = (-df * pdf * d) / sigmaN; // ∂Δ/∂σ_N
  const vomma = (df * sqrtT * d * d * pdf) / sigmaN; // ∂vega/∂σ_N
  const speed = (-df * d * pdf) / (sd * sd); // ∂Γ/∂F
  const charmCall = -rDf * normalCdf(d) - (df * pdf * d) / (2 * T);
  const charm = type === 'call' ? charmCall : charmCall + rDf; // ∂Δ/∂T
  const color = gamma * (-r + (d * d - 1) / (2 * T)); // ∂Γ/∂T
  const zomma = (gamma * (d * d - 1)) / sigmaN; // ∂Γ/∂σ_N
  const veta = df * pdf * (-r * sqrtT + (1 + d * d) / (2 * sqrtT)); // ∂vega/∂T
  const vera = -T * df * sqrtT * pdf; // ∂rho/∂σ_N = −T·vega
  const ultima = (df * sqrtT * pdf * (d ** 4 - 3 * d * d)) / (sigmaN * sigmaN); // ∂vomma/∂σ_N
  const lambdaRaw = (first.delta * F) / bachelierPrice(input); // Δ·F/V
  const lambda = Number.isFinite(lambdaRaw) ? lambdaRaw : null; // null at V=0, never ±∞/NaN

  return { ...first, vanna, charm, vomma, speed, color, zomma, veta, vera, ultima, phi: 0, lambda };
}

export interface BachelierImpliedVolatilityResult {
  value: number;
  converged: boolean;
  iterations: number;
  reason?: 'below_intrinsic' | 'price_below_resolvable' | 'no_bracket' | 'max_iterations';
}

/**
 * Solve Bachelier (normal) implied volatility. Reports failure honestly. Endpoint acceptance uses
 * the same RELATIVE tolerance as the BSM kernel (see {@link impliedVolatilityPriceTolerance}), so a
 * target below the σ_N→0 price floor fails as `price_below_resolvable` instead of being "matched" by
 * the bracket's low endpoint. The normal model has no upper price bound (the call price grows
 * without limit in σ_N), so there is no above-max case here.
 */
export function bachelierImpliedVolatility(
  input: BachelierImpliedVolatilityInput,
): BachelierImpliedVolatilityResult {
  requireArgumentObject('bachelierImpliedVolatility', 'input', input);
  ensureEnum(input.type, OPTION_TYPES, 'type', 'bachelierImpliedVolatility');
  // Same regression as Black-76, same fix: RV1 made the objective unchecked without establishing the
  // precondition. `forward: "100"` solved to a confident 22.50; an omitted `strike` blamed the solver
  // with `max_iterations`. The intrinsic bound below reads these fields, so this runs first.
  ensureKnownKeys('bachelierImpliedVolatility', 'input', input, BACHELIER_IV_KEYS);
  requireFiniteFields('bachelierImpliedVolatility', input, BACHELIER_IV_FIELDS, {
    exampleCall: BACHELIER_IV_EXAMPLE_CALL,
    hints: BACHELIER_HINTS,
  });
  const { type, price, forward: F, strike: K, timeToExpiryYears: T, riskFreeRate: r } = input;
  const df = Math.exp(-r * T);
  const lower = df * Math.max(0, type === 'call' ? F - K : K - F);
  if (price < lower - priceBoundSlack(lower))
    return { value: NaN, converged: false, iterations: 0, reason: 'below_intrinsic' };

  // Unchecked: validated once at the solver boundary; this runs per Brent iteration.
  const f = (normalVolatility: number): number =>
    bachelierPriceUnchecked({
      type,
      forward: F,
      strike: K,
      timeToExpiryYears: T,
      riskFreeRate: r,
      normalVolatility,
    }) - price;
  const lo = 1e-10;
  // Normal vol is in price units; scale the initial upper bracket to the problem.
  let hi = Math.max(1e-4, Math.abs(F) + Math.abs(K) + price);
  const ptol = impliedVolatilityPriceTolerance(price);
  const flo = f(lo);
  if (Math.abs(flo) <= ptol) return { value: lo, converged: true, iterations: 0 };
  // Target below the model price at the lowest representable σ_N ⇒ no σ_N ≥ lo reproduces it.
  if (flo > 0)
    return { value: NaN, converged: false, iterations: 0, reason: 'price_below_resolvable' };
  let fhi = f(hi);
  let exp = 0;
  while (fhi < 0 && exp < 20) {
    hi *= 2;
    fhi = f(hi);
    exp++;
  }
  if (fhi < 0) return { value: NaN, converged: false, iterations: 0, reason: 'no_bracket' };
  const res = brent(f, lo, hi, { tolerance: 1e-12, maximumIterations: 200 });
  return res.converged
    ? { value: res.value, converged: true, iterations: res.iterations }
    : { value: NaN, converged: false, iterations: res.iterations, reason: 'max_iterations' };
}

// ---- facade ----

const BACHELIER_KEYS = [
  'forward',
  'strike',
  'timeToExpiryYears',
  'riskFreeRate',
  'normalVolatility',
] as const;
const BACHELIER_TYPED_KEYS = [...BACHELIER_KEYS, 'type'] as const;
/** A solver does not accept the quantity it solves for — see `B76_IV_KEYS` for why this is spelled out. */
const BACHELIER_IV_KEYS = [
  'type',
  'price',
  'forward',
  'strike',
  'timeToExpiryYears',
  'riskFreeRate',
] as const;

function validate(input: BachelierInput, functionName: string): void {
  // Law 12 — the retired `vol` key keeps its richer units-teaching error below, so it is checked
  // FIRST; every other unknown key gets the generic did-you-mean.
  if (!('volatility' in (input as unknown as Record<string, unknown>))) {
    ensureKnownKeys(functionName, 'input', input, BACHELIER_TYPED_KEYS);
  }
  // Bachelier trades through zero: forward and strike may be negative (rates, spreads). Only the
  // volatility and time-to-expiry must be strictly positive.
  ensureFinite(input.forward, 'forward', functionName);
  ensureFinite(input.strike, 'strike', functionName);
  ensurePositive(
    input.timeToExpiryYears,
    'timeToExpiryYears',
    functionName,
    ErrorCode.InputNegativeTime,
  );
  if ('volatility' in (input as unknown as Record<string, unknown>)) {
    throw new InputError(
      `${functionName}: 'volatility' is not a Bachelier input — normal volatility is in PRICE UNITS and the field is named normalVolatility (Law 4: two different units never share a name). e.g. { forward: 100, strike: 100, timeToExpiryYears: 0.5, riskFreeRate: 0.02, normalVolatility: 15 }`,
      {
        code: ErrorCode.InputWrongShape,
        context: { function: functionName, received: 'volatility', expected: 'normalVolatility' },
      },
    );
  }
  ensurePositive(
    input.normalVolatility,
    'normalVolatility',
    functionName,
    ErrorCode.InputNegativeVolatility,
  );
  ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
}

function validateTyped(i: BachelierTypedInput, functionName: string): void {
  // `type: 'Call'` must teach, not silently price the other leg (design law #4).
  ensureEnum(i.type, OPTION_TYPES, 'type', functionName);
  validate(i, functionName);
}

function assumptions(t: number): Assumptions {
  return analyticAssumptions({ model: MODEL, timeToExpiryYears: t, units: UNITS });
}

function closedForm(input?: { timeToExpiryYears: number; riskFreeRate: number }): Diagnostics {
  // `.explain()` flags only the day-count-as-year-fraction footgun here. Bachelier vol is a NORMAL
  // vol in PRICE units — `vol: 22` is a perfectly legal 22-point vol, not a percent typo — so the
  // decimal-vs-percent check bs/black76 run would be a false alarm by construction.
  return {
    engine: MODEL,
    method: 'closed-form',
    converged: true,
    warnings: input ? plausibilityWarnings(input) : [],
  };
}

function priceTyped(i: BachelierTypedInput, functionName: string): number {
  validateTyped(i, functionName);
  return bachelierPrice(i);
}

// The type lives in the NAME for bachelier.call/put — a user-supplied `type` would be silently
// overridden by the spread (Law 12). The curated retired-`vol` teaching stays first.
const untyped = (i: BachelierInput, functionName: string): void => {
  if (!('volatility' in (i as unknown as Record<string, unknown>))) {
    ensureKnownKeys(functionName, 'input', i, BACHELIER_KEYS);
  }
};

// Wrapper construction is side-effect-free; expert imports must not retain unused facades.
const call = /* @__PURE__ */ facade(
  'bachelier.call',
  (i: BachelierInput) => (
    untyped(i, 'bachelier.call'),
    priceTyped({ ...i, type: 'call' }, 'bachelier.call')
  ),
  (i: BachelierInput): Computed<number> => (
    untyped(i, 'bachelier.call'),
    {
      value: priceTyped({ ...i, type: 'call' }, 'bachelier.call'),
      assumptions: assumptions(i.timeToExpiryYears),
      diagnostics: closedForm({
        timeToExpiryYears: i.timeToExpiryYears,
        riskFreeRate: i.riskFreeRate,
      }),
    }
  ),
);
const put = /* @__PURE__ */ facade(
  'bachelier.put',
  (i: BachelierInput) => (
    untyped(i, 'bachelier.put'),
    priceTyped({ ...i, type: 'put' }, 'bachelier.put')
  ),
  (i: BachelierInput): Computed<number> => (
    untyped(i, 'bachelier.put'),
    {
      value: priceTyped({ ...i, type: 'put' }, 'bachelier.put'),
      assumptions: assumptions(i.timeToExpiryYears),
      diagnostics: closedForm({
        timeToExpiryYears: i.timeToExpiryYears,
        riskFreeRate: i.riskFreeRate,
      }),
    }
  ),
);
const price = /* @__PURE__ */ facade(
  'bachelier.price',
  (i: BachelierTypedInput) => priceTyped(i, 'bachelier.price'),
  (i: BachelierTypedInput): Computed<number> => ({
    value: priceTyped(i, 'bachelier.price'),
    assumptions: assumptions(i.timeToExpiryYears),
    diagnostics: closedForm({
      timeToExpiryYears: i.timeToExpiryYears,
      riskFreeRate: i.riskFreeRate,
    }),
  }),
);
const greeks = /* @__PURE__ */ facade(
  'bachelier.greeks',
  (i: BachelierTypedInput): Greeks => {
    validateTyped(i, 'bachelier.greeks');
    return bachelierGreeks(i);
  },
  (i: BachelierTypedInput): Computed<Greeks> => {
    validateTyped(i, 'bachelier.greeks');
    return {
      value: bachelierGreeks(i),
      assumptions: assumptions(i.timeToExpiryYears),
      diagnostics: closedForm({
        timeToExpiryYears: i.timeToExpiryYears,
        riskFreeRate: i.riskFreeRate,
      }),
    };
  },
);
const extendedGreeks = /* @__PURE__ */ facade(
  'bachelier.extendedGreeks',
  (i: BachelierTypedInput): ExtendedGreeks => {
    validateTyped(i, 'bachelier.extendedGreeks');
    return bachelierExtendedGreeks(i);
  },
  (i: BachelierTypedInput): Computed<ExtendedGreeks> => {
    validateTyped(i, 'bachelier.extendedGreeks');
    const value = bachelierExtendedGreeks(i);
    return {
      value,
      assumptions: assumptions(i.timeToExpiryYears),
      diagnostics: withLambdaDisclosure(
        closedForm({ timeToExpiryYears: i.timeToExpiryYears, riskFreeRate: i.riskFreeRate }),
        value,
      ),
    };
  },
);

function impliedVolatilityExplain(i: BachelierImpliedVolatilityInput): Computed<number | null> {
  // Law 12 at the SHARED entry, so the plain facade and `.explain()` reject identically.
  ensureKnownKeys('bachelier.impliedVolatility', 'input', i, BACHELIER_IV_KEYS);
  ensureEnum(i.type, OPTION_TYPES, 'type', 'bachelier.impliedVolatility');
  ensurePositive(i.price, 'price', 'bachelier.impliedVolatility');
  ensureFinite(i.forward, 'forward', 'bachelier.impliedVolatility');
  ensureFinite(i.strike, 'strike', 'bachelier.impliedVolatility');
  ensurePositive(
    i.timeToExpiryYears,
    'timeToExpiryYears',
    'bachelier.impliedVolatility',
    ErrorCode.InputNegativeTime,
  );
  ensureFinite(i.riskFreeRate, 'riskFreeRate', 'bachelier.impliedVolatility');
  const res = bachelierImpliedVolatility(i);
  const a = assumptions(i.timeToExpiryYears);
  // The day-count-as-year-fraction footgun on `t` applies here like everywhere else.
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
        { code, message: `Bachelier implied vol failed (${res.reason})`, severity: 'error' },
        ...suspicious,
      ],
    },
  };
}

/** The Bachelier facade namespace. */
export const bachelier: {
  call: Facade<BachelierInput, number>;
  put: Facade<BachelierInput, number>;
  price: Facade<BachelierTypedInput, number>;
  greeks: Facade<BachelierTypedInput, Greeks>;
  extendedGreeks: Facade<BachelierTypedInput, ExtendedGreeks>;
  impliedVolatility: Facade<
    BachelierImpliedVolatilityInput,
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
    'bachelier.impliedVolatility',
    impliedVolatilityExplain,
    [ErrorCode.ImpliedVolatilityBelowIntrinsic],
    'implied vol did not converge',
  ),
}))();
