/**
 * `@insiderfinance/totalfinance/options/black-scholes` — the Black–Scholes facade.
 *
 * This is a HOT-PATH deep entrypoint (spec §6, §21.5). It imports only the BSM kernel, tiny core
 * invariants, and `@insiderfinance/totalfinance/math` — never schema machinery or other engines. Public inputs
 * retain their runtime guards. Whole-entrypoint and used-function budgets are tested separately;
 * see `docs/bundle-size.md` for current measurements and the supported import patterns.
 *
 * Each facade function returns a plain value and throws typed errors on failure. Its `.explain()`
 * companion returns the rich `{ value, assumptions, diagnostics }` envelope and reports quantitative
 * failures (non-convergence, below-intrinsic) in `diagnostics` instead of throwing (design law #3).
 */

import {
  ensureFiniteWhenPresent,
  type Assumptions,
  type Computed,
  type Diagnostics,
  ErrorCode,
  type QuantWarning,
  WarningCode,
  ensureEnum,
  ensureFinite,
  ensurePositive,
  plausibilityWarnings,
  ensureKnownKeys,
  requireFiniteFields,
  requireSelection,
  warning,
} from '@totalfinance/core';
import {
  BLACK_SCHOLES_OUTPUTS,
  type BlackScholesOutput,
  type BlackScholesOutputSelection,
  type BlackScholesPlan,
  evaluateBlackScholesScalarUnchecked,
  resolveBlackScholesPlan,
} from './bsm-evaluate.js';
import {
  blackScholesExtendedGreeks,
  blackScholesGreeks,
  blackScholesImpliedVolatility,
  blackScholesPriceUnchecked,
  type BlackScholesKernelInput,
} from './bsm.js';
import {
  withLambdaDisclosure,
  withUnderflowDisclosure,
  type Facade,
  analyticAssumptions,
  facade,
  impliedVolatilityFacadePair,
} from './facade-util.js';
import type {
  BlackScholesImpliedVolatilityInput,
  BlackScholesInput,
  BlackScholesTypedInput,
  ExtendedGreeks,
  Greeks,
} from './types.js';

const MODEL = 'black-scholes-merton';
const OPTION_TYPES = ['call', 'put'] as const;

const BSM_KEYS = [
  'spot',
  'strike',
  'timeToExpiryYears',
  'riskFreeRate',
  'volatility',
  'dividendYield',
] as const;
const BSM_TYPED_KEYS = [...BSM_KEYS, 'type'] as const;
const BSM_IV_KEYS = [...BSM_TYPED_KEYS, 'price'] as const;
const BSM_EVALUATE_KEYS = [...BSM_TYPED_KEYS, 'outputs'] as const;

/** The numeric legs the facade REQUIRES (`dividendYield` is optional and defaults to 0). */
const BSM_REQUIRED_NUMERIC = [
  'spot',
  'strike',
  'timeToExpiryYears',
  'riskFreeRate',
  'volatility',
] as const;

/**
 * Derived per METHOD, because `validateCore` is shared by five of them.
 *
 * One constant naming `blackScholes.price` meant a caller who omitted `volatility` on
 * `blackScholes.greeks` was shown a call to `.price` — a different method with a different return
 * type. `.call`/`.put` additionally carry the option type in the METHOD NAME, so an example with a
 * `type` field is not merely off-target there, it is a call they must not copy.
 */
const BSM_MARKET_LEGS =
  'spot: 100, strike: 105, timeToExpiryYears: 0.25, riskFreeRate: 0.04, volatility: 0.2';

function facadeExampleCall(functionName: string): string {
  // `.call` / `.put` own the convention in their name and reject a `type` key (Law 12).
  const typed = !/\.(call|put)$/.test(functionName);
  return `${functionName}({ ${typed ? "type: 'call', " : ''}${BSM_MARKET_LEGS} })`;
}

const BSM_FACADE_HINTS: Record<string, string> = {
  volatility: 'annualized decimal, not 20',
  riskFreeRate: 'annualized decimal',
  timeToExpiryYears: 'in years — 0.25 is three months, not 90',
};

function validateCore(
  input: BlackScholesTypedInput,
  functionName: string,
  allowedKeys: readonly string[] = BSM_TYPED_KEYS,
): number {
  // Law 12: an unknown field (a `divYield` typo, a stray `sigma`) teaches instead of being ignored.
  ensureKnownKeys(functionName, 'input', input, allowedKeys);
  // A meaning-changing field is never coerced (design law #4): `type: 'Call'` must teach, not
  // silently price the other leg.
  ensureEnum(input.type, OPTION_TYPES, 'type', functionName);
  /**
   * PRESENCE before DOMAIN, and the order is the whole point of the facade/kernel parity fixture.
   *
   * `ensurePositive(undefined)` reports `input.not_finite`, because `Number.isFinite(undefined)` is
   * false — technically true and useless: the caller did not pass a bad number, they passed no
   * number. The kernel says `input.missing_field` and names the field; the facade said "not finite"
   * for the same request, so the two layers described one mistake two ways. Presence is checked
   * first, on the same shared path the kernel uses, and the domain checks below then run on values
   * that are known to be finite numbers.
   *
   * `dividendYield` is deliberately absent here: the facade documents it as optional and defaults it
   * to 0 just below, which is a real difference from the kernel and not a parity defect.
   */
  requireFiniteFields(functionName, input, BSM_REQUIRED_NUMERIC, {
    exampleCall: () => facadeExampleCall(functionName),
    hints: BSM_FACADE_HINTS,
  });
  ensurePositive(input.spot, 'spot', functionName, ErrorCode.InputNegativeSpot);
  ensurePositive(input.strike, 'strike', functionName, ErrorCode.InputNegativeStrike);
  ensurePositive(
    input.timeToExpiryYears,
    'timeToExpiryYears',
    functionName,
    ErrorCode.InputNegativeTime,
  );
  ensurePositive(input.volatility, 'volatility', functionName, ErrorCode.InputNegativeVolatility);
  ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
  // Null is a wrong-typed value, not omission (the 350c2796 ruling): it used to coalesce
  // to 0 BEFORE the finite check and silently price a dividend-free underlying.
  ensureFiniteWhenPresent(input.dividendYield, 'dividendYield', functionName);
  const q = input.dividendYield ?? 0;
  return q;
}

function assumptions(t: number, q: number): Assumptions {
  return analyticAssumptions({
    model: MODEL,
    timeToExpiryYears: t,
    dividendModel: q === 0 ? 'none' : 'continuousYield',
  });
}

function closedForm(input?: {
  volatility: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
}): Diagnostics {
  // `.explain()` surfaces the classic unit footguns (vol as percent, t as day count) as info
  // warnings — the plain-value path stays silent-and-correct (plain-number law).
  return {
    engine: MODEL,
    method: 'closed-form',
    converged: true,
    warnings: input ? plausibilityWarnings(input) : [],
  };
}

function kernelInput(
  input: BlackScholesTypedInput,
  dividendYield: number,
): BlackScholesKernelInput {
  return {
    type: input.type,
    spot: input.spot,
    strike: input.strike,
    timeToExpiryYears: input.timeToExpiryYears,
    riskFreeRate: input.riskFreeRate,
    dividendYield,
    volatility: input.volatility,
  };
}

// ---- price (call / put / typed) ----

/**
 * `validateCore` above is the boundary: Law 12 keys, the `type` enum, presence-and-finiteness of every
 * numeric leg, then the domain checks. Calling the VALIDATING kernel after that re-ran the whole set a
 * second time on the flagship path — a regression introduced when the kernel gained its own field
 * checks, because before that it only checked the container and the enum. One validation, then math.
 */
function priceTyped(input: BlackScholesTypedInput, functionName: string): number {
  const q = validateCore(input, functionName);
  return blackScholesPriceUnchecked(kernelInput(input, q));
}

function explainTyped(input: BlackScholesTypedInput, functionName: string): Computed<number> {
  const q = validateCore(input, functionName);
  const value = blackScholesPriceUnchecked(kernelInput(input, q));
  return {
    value,
    assumptions: assumptions(input.timeToExpiryYears, q),
    // A price of exactly 0 is an underflow, not a free option — disclose it (Law 4).
    diagnostics: withUnderflowDisclosure(
      closedForm({
        volatility: input.volatility,
        timeToExpiryYears: input.timeToExpiryYears,
        riskFreeRate: input.riskFreeRate,
      }),
      value,
    ),
  };
}

// The type lives in the NAME for blackScholes.call/blackScholes.put — a user-supplied `type` would be silently
// overridden by the spread, so it is rejected like any unknown key (Law 12).
const untyped = (input: BlackScholesInput, functionName: string): void =>
  ensureKnownKeys(functionName, 'input', input, BSM_KEYS);

// These constructors only allocate callable/explain pairs. They do not calculate, validate an
// input, or invoke the callbacks until used. Expert-only imports may discard the unused pairs.
const call = /* @__PURE__ */ facade(
  'blackScholes.call',
  (input: BlackScholesInput) => (
    untyped(input, 'blackScholes.call'),
    priceTyped({ ...input, type: 'call' }, 'blackScholes.call')
  ),
  (input: BlackScholesInput) => (
    untyped(input, 'blackScholes.call'),
    explainTyped({ ...input, type: 'call' }, 'blackScholes.call')
  ),
);

const put = /* @__PURE__ */ facade(
  'blackScholes.put',
  (input: BlackScholesInput) => (
    untyped(input, 'blackScholes.put'),
    priceTyped({ ...input, type: 'put' }, 'blackScholes.put')
  ),
  (input: BlackScholesInput) => (
    untyped(input, 'blackScholes.put'),
    explainTyped({ ...input, type: 'put' }, 'blackScholes.put')
  ),
);

const price = /* @__PURE__ */ facade(
  'blackScholes.price',
  (input: BlackScholesTypedInput) => priceTyped(input, 'blackScholes.price'),
  (input: BlackScholesTypedInput) => explainTyped(input, 'blackScholes.price'),
);

// ---- greeks ----

const greeks = /* @__PURE__ */ facade(
  'blackScholes.greeks',
  (input: BlackScholesTypedInput): Greeks => {
    const q = validateCore(input, 'blackScholes.greeks');
    return blackScholesGreeks(kernelInput(input, q));
  },
  (input: BlackScholesTypedInput): Computed<Greeks> => {
    const q = validateCore(input, 'blackScholes.greeks');
    const value = blackScholesGreeks(kernelInput(input, q));
    return {
      value,
      assumptions: assumptions(input.timeToExpiryYears, q),
      diagnostics: closedForm({
        volatility: input.volatility,
        timeToExpiryYears: input.timeToExpiryYears,
        riskFreeRate: input.riskFreeRate,
      }),
    };
  },
);

// ---- one Greek, or a selected set (selective Greeks spec, decisions 4–6) ----

/**
 * Evaluate a validated typed input through a resolved plan. The returned slots are the kernel's
 * reused scalar outputs: read them before the next evaluation.
 */
function evaluatePlan(
  input: BlackScholesTypedInput,
  q: number,
  plan: BlackScholesPlan,
): Float64Array {
  return evaluateBlackScholesScalarUnchecked(plan, input, q);
}

function closedFormEnvelope<T>(input: BlackScholesTypedInput, q: number, value: T): Computed<T> {
  return {
    value,
    assumptions: assumptions(input.timeToExpiryYears, q),
    diagnostics: closedForm({
      volatility: input.volatility,
      timeToExpiryYears: input.timeToExpiryYears,
      riskFreeRate: input.riskFreeRate,
    }),
  };
}

/**
 * One named Greek: the facade validation, then a ONE-output plan — `blackScholes.gamma` evaluates
 * the normal density and no cumulative normal. The plan is resolved on the first call and reused,
 * so module evaluation does no computation and later calls resolve nothing.
 */
function singleGreek(
  output: Exclude<BlackScholesOutput, 'price'>,
): Facade<BlackScholesTypedInput, number> {
  const functionName = `blackScholes.${output}`;
  const slot = BLACK_SCHOLES_OUTPUTS.indexOf(output);
  let plan: BlackScholesPlan | undefined;
  const compute = (input: BlackScholesTypedInput): { q: number; value: number } => {
    const q = validateCore(input, functionName);
    plan ??= resolveBlackScholesPlan([output]);
    return { q, value: evaluatePlan(input, q, plan)[slot]! };
  };
  return facade(
    functionName,
    (input: BlackScholesTypedInput): number => compute(input).value,
    (input: BlackScholesTypedInput): Computed<number> => {
      const { q, value } = compute(input);
      return closedFormEnvelope(input, q, value);
    },
  );
}

const delta = /* @__PURE__ */ singleGreek('delta');
const gamma = /* @__PURE__ */ singleGreek('gamma');
const theta = /* @__PURE__ */ singleGreek('theta');
const vega = /* @__PURE__ */ singleGreek('vega');
const rho = /* @__PURE__ */ singleGreek('rho');

/**
 * Input for {@link blackScholes}.evaluate: the typed Black–Scholes input plus the outputs to compute.
 * `outputs` is required, nonempty, dense and duplicate-free.
 */
export interface BlackScholesEvaluateInput<
  O extends BlackScholesOutputSelection = BlackScholesOutputSelection,
> extends BlackScholesTypedInput {
  /** The outputs to compute, e.g. `['price', 'delta', 'gamma']`. Only these appear in the result. */
  outputs: O;
}

/**
 * The result of a selected evaluation. A literal selection gives exactly those required numbers; a
 * dynamic selection (`BlackScholesOutput[]`) gives optional properties, because the type cannot
 * know which outputs were requested and never claims one exists that was not.
 */
export type BlackScholesEvaluation<O extends BlackScholesOutputSelection> =
  number extends O['length'] ? { [K in O[number]]?: number } : { [K in O[number]]: number };

/** `blackScholes.evaluate` — a selected calculation with its `.explain` companion. */
export interface BlackScholesEvaluateFacade {
  /** An empty literal selection (`outputs: []`) is a compile error as well as a runtime one. */
  <const O extends BlackScholesOutputSelection>(
    input: BlackScholesEvaluateInput<O> &
      (O extends readonly []
        ? { outputs: readonly [BlackScholesOutput, ...BlackScholesOutput[]] }
        : unknown),
  ): BlackScholesEvaluation<O>;
  explain<const O extends BlackScholesOutputSelection>(
    input: BlackScholesEvaluateInput<O> &
      (O extends readonly []
        ? { outputs: readonly [BlackScholesOutput, ...BlackScholesOutput[]] }
        : unknown),
  ): Computed<BlackScholesEvaluation<O>>;
}

function evaluateSelected(input: BlackScholesEvaluateInput, functionName: string) {
  const q = validateCore(input, functionName, BSM_EVALUATE_KEYS);
  const outputs = requireSelection(functionName, 'outputs', input.outputs, BLACK_SCHOLES_OUTPUTS);
  const plan = resolveBlackScholesPlan(outputs);
  const scratch = evaluatePlan(input, q, plan);
  const value: Partial<Record<BlackScholesOutput, number>> = {};
  for (let index = 0; index < outputs.length; index++) {
    value[outputs[index]!] = scratch[plan.slots[index]!]!;
  }
  return { q, value };
}

const evaluate = /* @__PURE__ */ facade(
  'blackScholes.evaluate',
  (input: BlackScholesEvaluateInput) => evaluateSelected(input, 'blackScholes.evaluate').value,
  (input: BlackScholesEvaluateInput) => {
    const { q, value } = evaluateSelected(input, 'blackScholes.evaluate');
    const envelope = closedFormEnvelope(input, q, value);
    // A selected price of exactly 0 is an underflow, disclosed as on `.price.explain` (Law 4).
    return value.price === undefined
      ? envelope
      : { ...envelope, diagnostics: withUnderflowDisclosure(envelope.diagnostics, value.price) };
  },
) as unknown as BlackScholesEvaluateFacade;

// ---- higher-order greeks ----

const extendedGreeks = /* @__PURE__ */ facade(
  'blackScholes.extendedGreeks',
  (input: BlackScholesTypedInput): ExtendedGreeks => {
    const q = validateCore(input, 'blackScholes.extendedGreeks');
    return blackScholesExtendedGreeks(kernelInput(input, q));
  },
  (input: BlackScholesTypedInput): Computed<ExtendedGreeks> => {
    const q = validateCore(input, 'blackScholes.extendedGreeks');
    const value = blackScholesExtendedGreeks(kernelInput(input, q));
    return {
      value,
      assumptions: assumptions(input.timeToExpiryYears, q),
      diagnostics: withLambdaDisclosure(
        closedForm({
          volatility: input.volatility,
          timeToExpiryYears: input.timeToExpiryYears,
          riskFreeRate: input.riskFreeRate,
        }),
        value,
      ),
    };
  },
);

// ---- implied volatility ----
//
// `blackScholes.impliedVolatility` is the lean hot-path facade: it always uses the bracketed Brent solver — the
// robust universal default that converges whenever a solution exists — and reports `method: 'brent'`.
// Method selection (`auto`/`newton`/`halley`/`householder` + fallback) lives on the richer paths that
// don't carry the 8 KB facade budget: the pro `option.impliedVolatility({ contract: contract, market: market, method })` and
// the standalone `impliedVolatility(input, options)`.

function validateImpliedVolatility(input: BlackScholesImpliedVolatilityInput): number {
  ensureKnownKeys('blackScholes.impliedVolatility', 'input', input, BSM_IV_KEYS);
  ensureEnum(input.type, OPTION_TYPES, 'type', 'blackScholes.impliedVolatility');
  ensurePositive(input.price, 'price', 'blackScholes.impliedVolatility');
  ensurePositive(input.spot, 'spot', 'blackScholes.impliedVolatility', ErrorCode.InputNegativeSpot);
  ensurePositive(
    input.strike,
    'strike',
    'blackScholes.impliedVolatility',
    ErrorCode.InputNegativeStrike,
  );
  ensurePositive(
    input.timeToExpiryYears,
    'timeToExpiryYears',
    'blackScholes.impliedVolatility',
    ErrorCode.InputNegativeTime,
  );
  ensureFinite(input.riskFreeRate, 'riskFreeRate', 'blackScholes.impliedVolatility');
  // Null is a wrong-typed value, not omission (the 350c2796 ruling): it used to coalesce
  // to 0 BEFORE the finite check and silently price a dividend-free underlying.
  ensureFiniteWhenPresent(input.dividendYield, 'dividendYield', 'blackScholes.impliedVolatility');
  const q = input.dividendYield ?? 0;
  return q;
}

/**
 * Ill-conditioning disclosure for a converged inverse (Law 4): vega is `∂price/∂σ`, so when it
 * collapses toward zero a one-tick price change moves the implied volatility by a lot — the number is
 * exact for the price given, and nearly meaningless as an estimate. The suite path
 * (`impliedVolatility(input, options)`) has always said so; the lean facade now says it too, which is
 * what keeps a recovered σ from a 1e-12 premium from reading like a normal quote.
 */
function lowVegaWarnings(
  input: BlackScholesImpliedVolatilityInput,
  dividendYield: number,
  volatility: number,
): QuantWarning[] {
  // Greeks report vega per 1% of σ; the conditioning test is on the per-1.00 derivative.
  const vega =
    100 *
    blackScholesGreeks({
      type: input.type,
      spot: input.spot,
      strike: input.strike,
      timeToExpiryYears: input.timeToExpiryYears,
      riskFreeRate: input.riskFreeRate,
      dividendYield,
      volatility,
    }).vega;
  if (vega >= 1e-4 * input.spot) return [];
  return [
    warning(
      WarningCode.ImpliedVolatilityLowVega,
      'vega is near zero; the implied volatility is ill-conditioned',
      'warn',
      { vega },
    ),
  ];
}

function impliedVolatilityExplain(
  input: BlackScholesImpliedVolatilityInput,
): Computed<number | null> {
  const q = validateImpliedVolatility(input);
  const res = blackScholesImpliedVolatility({
    type: input.type,
    price: input.price,
    spot: input.spot,
    strike: input.strike,
    timeToExpiryYears: input.timeToExpiryYears,
    riskFreeRate: input.riskFreeRate,
    dividendYield: q,
  });
  const a = assumptions(input.timeToExpiryYears, q);
  // The IV input has no vol, but the day-count-as-year-fraction footgun still applies to `t` —
  // `.explain()` surfaces it the same way blackScholes.price.explain does (the plain path stays silent).
  const suspicious = plausibilityWarnings({
    timeToExpiryYears: input.timeToExpiryYears,
    riskFreeRate: input.riskFreeRate,
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
        warnings: [...lowVegaWarnings(input, q, res.value), ...suspicious],
      },
    };
  }
  const { code, message, severity } = impliedVolatilityFailure(res.reason);
  return {
    value: null,
    assumptions: a,
    diagnostics: {
      engine: MODEL,
      method: 'brent',
      converged: false,
      iterations: res.iterations,
      warnings: [{ code, message, severity }, ...suspicious],
    },
  };
}

function impliedVolatilityFailure(reason: string | undefined): {
  code: string;
  message: string;
  severity: 'warn' | 'error';
} {
  switch (reason) {
    case 'below_intrinsic':
      return {
        code: ErrorCode.ImpliedVolatilityBelowIntrinsic,
        message: 'price is below intrinsic value; no implied volatility exists',
        severity: 'error',
      };
    case 'above_max_bound':
      return {
        code: ErrorCode.ImpliedVolatilityAboveMax,
        message:
          'price is at or above the no-arbitrage upper bound (the σ→∞ limit); no implied volatility exists',
        severity: 'error',
      };
    case 'price_below_resolvable':
      return {
        code: ErrorCode.ImpliedVolatilityPriceBelowResolvable,
        message: 'price is below the σ→0 price floor of this model; no implied volatility exists',
        severity: 'error',
      };
    default:
      return {
        code: ErrorCode.ImpliedVolatilityNoConvergence,
        message: 'implied-volatility solver did not converge',
        severity: 'error',
      };
  }
}

/**
 * The Black–Scholes facade namespace. Flat object arguments in, plain values out; `.explain()` on
 * each function returns the assumptions/diagnostics envelope.
 *
 * @example
 * ```ts
 * import { blackScholes } from '@insiderfinance/totalfinance/options';
 *
 * blackScholes.price({ spot: 100, strike: 105, timeToExpiryYears: 30 / 365, riskFreeRate: 0.045, volatility: 0.22, type: 'call' });
 * // → 0.898…  (plain number)
 *
 * const { value, assumptions, diagnostics } = blackScholes.greeks.explain({
 *   spot: 100, strike: 105, timeToExpiryYears: 30 / 365, riskFreeRate: 0.045, volatility: 0.22, type: 'call',
 * });
 * // value.delta, value.theta (per day), … — with every assumption disclosed
 * ```
 */
export const blackScholes: {
  call: Facade<BlackScholesInput, number>;
  put: Facade<BlackScholesInput, number>;
  price: Facade<BlackScholesTypedInput, number>;
  /** Delta alone (per share per 1.00 of spot). Computes no other Greek. */
  delta: Facade<BlackScholesTypedInput, number>;
  /** Gamma alone (per 1.00 of spot). Evaluates the normal density and no cumulative normal. */
  gamma: Facade<BlackScholesTypedInput, number>;
  /** Theta alone, per calendar day. */
  theta: Facade<BlackScholesTypedInput, number>;
  /** Vega alone, per 1 volatility point (0.01). */
  vega: Facade<BlackScholesTypedInput, number>;
  /** Rho alone, per 1% of the risk-free rate. */
  rho: Facade<BlackScholesTypedInput, number>;
  greeks: Facade<BlackScholesTypedInput, Greeks>;
  extendedGreeks: Facade<BlackScholesTypedInput, ExtendedGreeks>;
  /**
   * Several selected outputs from one shared evaluation —
   * `evaluate({ ...input, outputs: ['price', 'delta', 'gamma'] })`. Only the requested outputs and
   * their dependencies are computed, and only they appear in the result.
   */
  evaluate: BlackScholesEvaluateFacade;
  impliedVolatility: Facade<
    BlackScholesImpliedVolatilityInput,
    number,
    Record<never, never>,
    number | null
  >;
} = /* @__PURE__ */ (() => ({
  call,
  put,
  price,
  delta,
  gamma,
  theta,
  vega,
  rho,
  greeks,
  extendedGreeks,
  evaluate,
  impliedVolatility: impliedVolatilityFacadePair(
    'blackScholes.impliedVolatility',
    impliedVolatilityExplain,
    [ErrorCode.ImpliedVolatilityBelowIntrinsic, ErrorCode.ImpliedVolatilityAboveMax],
    'implied volatility did not converge',
  ),
}))();

// The expert kernel surface of this model subpath (P3.3): direct scalar results with required,
// named financial inputs. Zero added bundle cost — the facade already imports them.
export {
  blackScholesPrice,
  blackScholesGreeks,
  blackScholesExtendedGreeks,
  blackScholesImpliedVolatility,
  blackScholesPriceBounds,
} from './bsm.js';
export type { BlackScholesOutput, BlackScholesOutputSelection } from './bsm-evaluate.js';
export type {
  BlackScholesKernelInput,
  BlackScholesPriceBoundsInput,
  BlackScholesImpliedVolatilityKernelInput,
  BlackScholesImpliedVolatilityOptions,
  BlackScholesImpliedVolatilityResult,
} from './bsm.js';
